# Prometheus 高流失率（series churn）：影响、系统化治理方案与云厂商现状

## 直接结论

**高流失率是指“序列身份在持续被制造又废弃”，而不是峰值序列数高；它的主要代价是持续不断的序列创建与索引工作、head block 内存与 WAL 的持续增长、查询变慢与账单上涨，并且它会掩盖在“重启后一切正常”的假象之下。** [1](#evidence-1)[2](#evidence-2)[3](#evidence-3)[4](#evidence-4) 置信度：高。机制层面有 Prometheus 官方文档与运维实践双重支撑。

**系统化解法存在，但必须是“分层”的，而不是某一个开关**：先在源头消灭无界标签（含 version/git_sha、原始 path、request_id），再用摄入侧闸门（整条指标丢弃、sample/label/target 限额）止血，然后用 recording rules 或 native histograms 降低表示成本，最后才谈换后端或改架构 [5](#evidence-5)[6](#evidence-6)[7](#evidence-7)[8](#evidence-8)[9](#evidence-9)。关键反直觉点：**不要在抓取时用 `labeldrop` 去掉承担唯一性的标签**，那会把不同序列合并、直接破坏 `rate()` [10](#evidence-10)[11](#evidence-11)。

**云厂商方面：AWS、Azure、GCP 都有围绕基数/摄入的配额、计量与治理工具，但“专门针对 churn 的产品”几乎不存在。** 唯一带 churn 语义的硬限制是 GCP 对“每分钟新建指标/新增标签定义”的限流 [12](#evidence-12)。AWS、Azure 的机制是“活跃序列配额 + 按样本计量 + 上限告警”，churn 通过账单和配额间接体现，而不是通过一个 churn 指标 [13](#evidence-13)[14](#evidence-14)[15](#evidence-15)。置信度：中高（厂商文档为一手材料，但没有任何一家用 “churn” 这个词描述自己的功能，跨厂商结论含推断成分）。

---

## 1. 先厘清概念：churn 与高基数是两个问题

Prometheus 不存“一条指标带若干 tag”，而是**每个唯一 metric+labelset 组合就是一条独立时间序列**，加一个标签是在乘序列数，不是加元数据 [16](#evidence-16)[17](#evidence-17)。在此之上要区分两种失败模式：

- **稳态高基数**：大量有界但组合爆炸的维度（`instance`、`pod`、`route`、`status`、`method`）长期存在，主要把内存压力长期抬高 [18](#evidence-18)。
- **序列流失（churn）**：标签组合快速出现又消失，Prometheus 必须**持续创建新的序列身份并更新索引结构**，即使瞬时活跃序列数看起来并不灾难 [1](#evidence-1)。典型来源是编码了临时 pod、job ID、request ID、临时路径、短命任务名的标签 [1](#evidence-1)。

两者会重叠但修复方式不同，把 churn 当成“临时性高基数”会漏掉“持续制造序列”的那部分成本 [2](#evidence-2)。

**如何观测**：churn 的规范信号是创建速率与移除速率的对比，而不是快照计数 [19](#evidence-19)：

```
rate(prometheus_tsdb_head_series_created_total[5m])
rate(prometheus_tsdb_head_series_removed_total[5m])
```

持续出现“创建速率显著超过移除速率”就意味着基数在单向上行 [19](#evidence-19)；把创建量与样本速率对照可以看出“churn 型”还是“纯摄入量型”增长（例如 request id 被误提升为标签）[20](#evidence-20)。`/api/v1/status/tsdb` 提供的是 `headStats.numSeries`、按指标名的序列数、按标签名的值数、按标签名的内存占用、按标签值对的序列数——**它是基数画像，不含 churn 计数**，churn 必须回到 `_created_total`/`_removed_total` [21](#evidence-21)[19](#evidence-19)。离线侧 `promtool tsdb analyze` 明确用于 “analyze churn, label pair cardinality and compaction efficiency” [22](#evidence-22)。

---

## 2. 高流失率会造成什么影响

**（1）head block 内存被持续占用，且 churn 的旧序列不会立刻释放。** TSDB 的 head 把活跃序列和近期样本放在内存里，序列数上升内存就上升 [2](#evidence-2)[23](#evidence-23)。churn 驱动的 head 会**一直携带已废弃的旧序列直到 TSDB compaction** [3](#evidence-3)。作者实测的定性结论是“推动内存数字的是序列数，而不是抓取量；每条序列在 head 里是持续占用 RAM，而不是按请求计费” [24](#evidence-24)，且每条唯一 labelset 都对应一份 RAM 成本 [25](#evidence-25)。

**（2）一个关键的运维陷阱：`retention.size` 并不能限制 head 内存。** 官方语义是只删除持久化 block，虽然 WAL 和 m-mapped chunks 计入总量；它约束的是磁盘、以及长期来看基数爆炸能在磁盘上堆积多少，**但不封顶 RAM 中的 head block** [26](#evidence-26)。所以“我设了 retention 上限所以安全”是错误的安全感。

**（3）WAL 与磁盘增长，并且和 compaction 故障相互放大。** WAL 在两次清理之间本应呈现锯齿状增长，要判断的是峰值是否逐周期抬升，而不是目录此刻是否变大 [27](#evidence-27)。churn 与“纯样本量上升”要分开：序列快速创建而样本量温和增长，是 churn 的特征 [20](#evidence-20)。WAL 增长叠加反复的 compaction 失败，比单纯磁盘增长是更强的故障证据 [20](#evidence-20)。时间保留策略不是 WAL 大小的直接控制手段，也不该把删 WAL 文件当常规清理 [28](#evidence-28)。

**（4）索引与 compaction 的 CPU/IO 常驻开销。** churn 的代价不止样本负载，还包括维持样本可查询、可追加所需的**每条序列的结构**；活跃序列上升，head 内存随之上升 [2](#evidence-2)。churn 之所以昂贵，正是因为反复创建大量短命序列会**持续触发序列创建与索引工作**，而不只是让当前活跃序列快照变大 [23](#evidence-23)。作者的总结更直接：churn 在稳态图表看起来很平静时依然在制造工作量 [29](#evidence-29)。

**（5）查询变慢、MTTR 变长。** 基数上升意味着需要更多基础设施与算力来存储和处理这些时间序列，并且**任何一次查询触及的时间序列数都会增加，从而显著拖慢查询与可视化**；加载缓慢的仪表盘和返回缓慢的查询会延长故障排查时间 [4](#evidence-4)。症状表把“单个 PromQL 查询变慢或打挂 querier”直接归因于查询中某条指标基数过高 [30](#evidence-30)。

**（6）成本。** 基数直接推高可观测性平台开销，这一点已是运营与集中式可观测团队的关注焦点 [4](#evidence-4)。云侧的传导路径见第 4 节。

**（7）最隐蔽的一条：OOM 被重启策略掩盖。** `restart: unless-stopped` 会真的隐藏容量问题——没有它，OOM 会表现为容器死亡、仪表盘缺口、告警；有了它，容器反复重启而表面读数是绿的 [24](#evidence-24)。判据是看启动时的 WAL replay 日志，“一天内 replay 超过一次”就是在告诉你有问题 [24](#evidence-24)，以及 Grafana 中可见的抓取缺口 [31](#evidence-31)。

**（8）止损手段的边界。** 重启 Prometheus 会丢掉 churn 出来的序列，但这不是修复，修复在源头 [3](#evidence-3)。

---

## 3. 根因：churn 从哪里来

按“症状—成因”对照，deploy 相关的 churn 尖峰有很高的可诊断性 [3](#evidence-3)：

| 根因 | 可观察特征 | 证据 |
|---|---|---|
| Pod 滚动发布导致 `pod` 标签换值 | churn 尖峰与部署时间对齐 | [3](#evidence-3) |
| 每条指标都带 `version`/`git_sha`/`image_tag` | 每次部署跨大量指标同时尖峰 | [3](#evidence-3) |
| `instance` 里塞临时主机名 | 与云上弹性伸缩事件时间对齐 | [3](#evidence-3) |
| Bug：动态标签名 | churn 持续攀升、永不平台化 | [3](#evidence-3) |
| 应用把新 UUID 当标签值 | 线性无界增长、与部署无相关性 | [3](#evidence-3) |
| 新抓取目标被加入配置 | 序列数阶跃 | [31](#evidence-31) |

把 `prometheus_tsdb_head_series` 与 `changes(app_build_info[1d])` 叠加，若序列数出现与部署对齐的垂直台阶，即可定案 [19](#evidence-19)。

结构性成因还有几类：kube-state-metrics 的指标本身会随状态变化产生新序列（如 `kube_pod_status_phase` 在 pending→running→failed 时各生成一条），短命 Job 多时单个 Pod 的状态跟踪就能产生大量指标 [32](#evidence-32)；微服务自治 + 丰富的 exporter 生态让治理变得困难 [32](#evidence-32)；随机生成、无上界的标签（`session_id`、`user_id`、`device_id`）会在流量上升时让序列数尖峰 [33](#evidence-33)。风险最高的模式清单是：`user_id`、`session_id`、`request_id`、原始 URL/path、自由文本错误信息、完整异常栈、过细粒度的临时容器/任务标识 [5](#evidence-5)。官方数据模型指引同样明确：**不要用标签存放高基数维度（用户 ID、邮箱等无界集合）** [17](#evidence-17)。

还有一类“定义层 churn”，在托管服务上会以配额错误形式暴露：反复快速变更指标定义，使一个指标名在整个生命周期内实质上拥有多套互不相同的标签键集合 [34](#evidence-34)；GCP 对此有专门的每分钟限流，且官方说明该限流**通常在把成熟的自建 Prometheus 迁移过去时才会触发**，并强调它“不是对数据点摄入的限流，只作用于创建从未出现过的指标或给已有指标加新标签” [12](#evidence-12)。

---

## 4. 系统化方案：一个六层框架

### 第 0 层：止血（分钟级）
生产 OOM 或摄入 429 时，**唯一安全的抓取期动作是把整条越界指标丢掉**，而不是删标签：

```yaml
metric_relabel_configs:
  - source_labels: [__name__]
    regex: http_requests_total
    action: drop
```
[35](#evidence-35)

代价是会完全失去这条指标直到源码修复——这是明确的取舍，而不是静默的数据污染 [35](#evidence-35)。`metric_relabel_configs` 在摄入前最后一步生效，正是用来“排除太贵而不值得摄入的时间序列” [36](#evidence-36)。

### 第 1 层：定位（谁在制造序列）
- `rate(prometheus_tsdb_head_series_created_total[5m])` vs `_removed_total` [19](#evidence-19)；对照样本追加速率区分 churn 与摄入量 [20](#evidence-20)。
- `/api/v1/status/tsdb`：`numSeries`、`seriesCountByMetricName`、`labelValueCountByLabelName`、`memoryInBytesByLabelName`、`seriesCountByLabelValuePair`，`limit` 可到 10000 [21](#evidence-21)。
- `promtool tsdb analyze`（含 `--extended`、`--limit`）离线分析 churn 与标签对基数 [22](#evidence-22)；`promtool check metrics --extended` 对 `/metrics` 输出做基数分析 [37](#evidence-37)。
- `mimirtool` 找出未被任何仪表盘/告警/记录规则使用的指标，可安全丢弃 [38](#evidence-38)。

### 第 2 层：源头修复（唯一真正的修复）
- **版本信息走 info-metric**，不要作为每条指标上的 `version`/`git_sha`；`pod` 要保留，不能删 [6](#evidence-6)。
- **path 在应用里模板化**（`/users/:id`），而不是在抓取时用 relabel 折叠 [39](#evidence-39)[5](#evidence-5)。
- 把 per-request / per-user 细节移入日志与 trace，标签只保留真正要 group/filter/alert 的维度 [40](#evidence-40)。
- 一个可操作的评审问句：**如果这个标签下个月值多 10 倍，这条指标还值它的成本吗？** 若否，它不该进 Prometheus [40](#evidence-40)。
- 在 CI/上线前评审：确认每个拟新增标签的值集有界、且只用于聚合而非取证式查询 [40](#evidence-40)。

### 第 3 层：摄入闸门（断路器，不是截断器）
ServiceMonitor 提供 `sampleLimit`、`targetLimit`、`labelLimit`、`labelNameLengthLimit`、`labelValueLengthLimit`（配合 `bodySizeLimit`），全部是**断路器**：超限时按各自语义让目标或整次抓取失败，**不会保留前 N 条** [41](#evidence-41)[42](#evidence-42)。官方语义：超限时“整次抓取被视为失败”，`0` 表示无限制 [7](#evidence-7)。所以：

- 限额治的是“单次响应突然多出几千条序列”这类事故，**治不了 `user_id`**——一个标签就能轻易低于 `labelLimit`，但上百万取值就是上百万条序列，没有任何标签数量上限能修这个数据模型选择 [43](#evidence-43)。
- **先减浪费再收紧断路器**：用 `metricRelabelings` 丢掉从不被查询的指标，因为 metric relabeling 在 `sampleLimit` 之前执行，能降低被计数的样本量；但它不减少下载字节和 exporter 的开销，能关的 collector family 应直接关掉 [43](#evidence-43)。
- 用 target relabeling 或更窄的 Service selector 再去依赖 `targetLimit` [43](#evidence-43)。

### 第 4 层：表示与聚合（降成本而不丢可观测性）
- **recordings rules 预聚合**：官方迁移指南明确建议用它在下发给托管服务之前降低基数 [44](#evidence-44)；Azure 侧同样把 recording rules 作为高基数指标的优化手段，并给出 `avg(rate(...)) by (job)` 这类聚合式记录规则，以及“限制规则作用域到特定集群以加速”的实践 [45](#evidence-45)[46](#evidence-46)。
- **federation 只联邦聚合后的 recording rules，不联邦原始指标**（`match[]` 用 `.*:.*` 命名约定）[47](#evidence-47)。
- **native histograms 替代 classic histograms**：无需预定义 bucket 边界、动态调整分辨率、稀疏表示使空桶零成本；新的埋点应优先用它 [8](#evidence-8)。histogram 是基数的传统放大器，减少底层 histogram 上的标签是最大收益点，随后才是减少 bucket 数，高分辨率延迟场景再考虑 native histograms [39](#evidence-39)[6](#evidence-6)。
- **histogram bucket 可安全裁剪**：bucket 是累积的，丢掉 `le="10"` 的序列，其值会计入 `le="25"`，不构成数据丢失 [48](#evidence-48)。

### 第 5 层：抓取与保留的显式取舍
把可选项的成本摊开看，避免“只调大内存”这一种反射动作 [49](#evidence-49)：

| 手段 | 代价 |
|---|---|
| 提高 `mem_limit` | 主机 RAM，挤占同机其他容器 |
| 拉长抓取间隔（15s→60s） | 分辨率，短时尖峰细节丢失 |
| 减少抓取目标 | 覆盖度——而这正是这套栈存在的理由 |
| 缩短 `--storage.tsdb.retention.time` | 事后排障所需的历史 |
| 限制 `--storage.tsdb.retention.size` | 基本没什么代价，直到它开始静默丢老 block |
| 移除高基数标签 | 若这些标签本来就没被查询，则无代价 |

[49](#evidence-49)（注意最后一行的前提条件，以及 `retention.size` 不封顶 RAM 的限定 [26](#evidence-26)。）云侧同样把“按指标重要性调 `scrape_interval`/`scrape_timeout`”列为首要建议 [50](#evidence-50)。

### 第 6 层：架构
- **agent 模式 / 纯 remote-write 完全不留本地 head block**，把“head 内存怎么算”这个问题整体消掉 [9](#evidence-9)。
- 分片 + remote write 的 agent 模式（Grafana Agent / ADOT）能降低单机内存需求，典型部署相对其他 agent 可减少约 40% 内存占用，但**代价是失去本地 recording/alerting 规则能力** [51](#evidence-51)[52](#evidence-52)。
- 用 `write_relabel_configs` 在发往远端前限制发送哪些样本 [53](#evidence-53)。
- 托管 Mimir 这类后端“不会随序列数增长而出现这些性能问题” [54](#evidence-54)——但注意 Prometheus 的内存 sizing 逻辑**不能直接迁移**到 VictoriaMetrics 或 Mimir，因为它们存储引擎不同、内存剖面不同；Thanos/Cortex 联邦部署也是另一套 per-shard 剖面 [9](#evidence-9)。**本证据库中没有 Thanos/Cortex/VictoriaMetrics 之间 churn 容忍度的对比基准**，因此无法给出排序。

### 横切：治理与 CI
- `pint` 提供 CI PR lint、按文件/目录的临时 lint、以及持续巡检并暴露指标的 daemon 三种模式 [55](#evidence-55)[56](#evidence-56)。但**在本库检入的 pint 文档中，没有出现 cardinality 或 churn 相关检查项** [57](#evidence-57)——也就是说它治的是规则层面的问题，不是序列基数。
- 需要坦白的一点：**“基数预算 / 基数 SLO”作为正式实践，在本证据库中没有任何来源支撑**，它只能作为提议性构造，而不是既有做法。

### 最重要的反模式（放最后强调）
`labeldrop` / 在抓取时“归一化”承担唯一性的标签，是本主题里最常见也最有害的“修复”：

- 不能删除任何使序列唯一的标签——不是 `pod`、不是 `instance`、不是任何区分真实序列的东西。它看起来止住了出血，实际上**破坏了数据**：来自不同序列的 counter reset 被合并，`rate()` 与 `increase()` 返回垃圾值，而且常常是荒谬地高 [10](#evidence-10)。
- 官方配置文档本身也警告 `labeldrop`/`labelkeep` 必须确保删标签后指标仍然唯一标注 [36](#evidence-36)。
- 把 `/users/123`、`/users/456` 折叠成 `/users/:id` 会造成 duplicate-sample 错误与 `rate()` 断裂；**合并必须发生在源头（模板化）或摄入后（Adaptive Metrics），绝不能在抓取时** [11](#evidence-11)。
- 唯一相对安全的 `labeldrop` 是删除与目标标签**完全重复**的应用侧标签（如 `exported_instance` 这类碰撞产物），必须严格限定名字范围，**永远不要包含 `pod`** [35](#evidence-35)。

---

## 5. 各家云厂商的现有方案

### AWS — Amazon Managed Service for Prometheus (AMP)

**有配额，且配额可细化到标签集。** 工作区支持设置 `Default bucket limit`（对不匹配任何已定义标签集的时间序列生效的活跃序列上限），以及为每个标签集单独设置 `Active series limit` [58](#evidence-58)。运维指南给出的默认配额示例包括：当前活跃序列 1,000,000（`prometheus_tsdb_head_series`）、当前摄入速率 70,000 samples/s、按指标名的活跃序列 top 列表（200,000）、每条指标的标签数（70）；超配额时 `remote_write` 返回 429，可用支持工单提升（除非配额页列为硬限制）[13](#evidence-13)[59](#evidence-59)。建议是在达到阈值（例如 80%）之前就用上述查询建 Grafana 告警 [13](#evidence-13)。

**计量方式使 churn 直接变成账单。** 按摄入的样本计量（示例单价 €0.888 / 10M 样本，前 20 亿），存储按 GB 计且**元数据（指标名、标签、标签值）按天存储**，示例假设每标签/标签值平均 30 字节、每样本 2 字节；查询按 QSP（Query Samples Processed）计量 [15](#evidence-15)[60](#evidence-60)。这意味着 churn 有两条涨价路径：新序列带来新样本，以及**新的标签值反复产生新的元数据条目**——不过需要说明：**AWS 文档没有用“churn”这个词描述这一点，这是基于其计量规则的推断，不是原文表述**。

**官方立场偏“我们扛得住 + 你该自己降”。** AMP 与 Prometheus 都被描述为“为处理高基数指标而设计” [61](#evidence-61)；同时明确警告不要把 `user_id` 这类高基数标签加进指标，否则会有几十万条只有单个数据点的时间序列、查询慢到不可用，并建议用 recording rules 在自建 Prometheus 侧**预聚合后再发往 AMP** [44](#evidence-44)。此外提供托管 collector 与 ADOT / Grafana Agent 的摄取路径 [52](#evidence-52)。

**缺口**：AWS 没有提供 churn 专用的指标、仪表盘或自动聚合功能；对我的检索范围而言，churn 只能通过“活跃序列配额 + 按样本/元数据计量”间接治理。

### Azure — Azure Monitor managed service for Prometheus

**有内建的利用率观测与告警建议，且明确以“活跃时间序列”为对象。** 官方最佳实践要求在工作区的 Metrics 中确认 **Active Time Series % Utilization** 与 **Events Per Minute Ingested % Utilization** 低于 100%，并设置利用率超过上限 80% 时触发的告警 [14](#evidence-14)。这是三家主流云里**最接近“开箱即用的基数健康度仪表”**的做法。

**降基数的具体手段**：识别高基数指标 [62](#evidence-62)；按指标重要性调 `scrape_interval`/`scrape_timeout`；对高基数指标用 `metric_relabel_configs` 丢弃不必要的标签以降低序列数 [50](#evidence-50)；用 recording rules 预计算降低查询成本（尤其对多面板、高基数指标的仪表盘）[45](#evidence-45)[46](#evidence-46)；用额外的 DCR/DCE 把摄入负载分散到多个端点 [62](#evidence-62)。

**计量**：定价简化为基于摄入与查询，保留 18 个月且存储不计费 [63](#evidence-63)。**churn 的传导是“摄入量 + 活跃序列利用率”，而不是单独的 churn 计费项**——同样属于推断，Azure 文档未使用 churn 一词。

### Google Cloud — Managed Service for Prometheus

**唯一有 churn 语义硬限制的一家。** 触发 “You have hit the per-project limit on metric definition or label definition changes per minute” 时，说明命中了**每分钟创建新指标、给已有指标添加新标签的速率限制**；官方明确该限流不是对数据点摄入的限流，只作用于从未出现过的指标或新增标签，配额固定，会随着新指标/标签逐步创建而自动缓解 [12](#evidence-12)。这实际上就是对“定义层 churn”的限速器。

**标签层限制**：单指标标签数超限会报 “The new labels would cause the metric ... to have over N labels”，通常由“快速变更指标定义、使一个指标名在生命周期内拥有多套标签键”引起；官方特别提醒**标签数量（label names/keys/dimensions）与基数（所有标签上唯一标签值组合的数量）是两个不同概念** [64](#evidence-64)[34](#evidence-34)。此外最小抓取间隔为 5 秒，短于 5 秒会引发时间序列碰撞问题 [34](#evidence-34)。

**治理工具**：Metrics Management 页面可查看字节/样本维度的摄入量、指标的标签与基数信息、各指标读取次数、在告警策略与自定义仪表盘中的使用情况、写入错误率，并可**排除不需要的指标以消除其摄入成本** [65](#evidence-65)；降低基数与成本的官方路径是“本地聚合（local aggregation）后再送往 Monarch”，并明确指出应停止用 federation 做这件事、删除修改指标名的 relabel 规则 [66](#evidence-66)。读取侧超限报 429 RESOURCE_EXHAUSTED [67](#evidence-67)，摄入配额可申请提升 [68](#evidence-68)。

### Grafana Cloud / Mimir（非三大云，但方案最完整）

- **计量以活跃序列为单位**（Active Series），并有 DPM 作为第二计量维度；账单尖峰的原因被直接分成“新指标/新标签/发布造成的 churn”与“抓取间隔缩短或 remote_write 重复”两类 [69](#evidence-69)[70](#evidence-70)。
- **cardinality management dashboards** 内建于 Pro/Advanced 计划，用于识别高基数指标与标签并指导优化 [71](#evidence-71)。
- **Adaptive Metrics 是摄入后聚合的“安全路径”**：churn 若由部署驱动，先停止应用侧发射 `version`/`git_sha`/`instance`（改用 info-metric），**保留 `pod`**；若 pod 级序列确实太贵，走 Adaptive Metrics [6](#evidence-6)[72](#evidence-72)。它也是唯一能在不破坏数据的前提下把 path 之类维度“正确聚合掉”的手段 [11](#evidence-11)。
- Mimir 作为后端不会随序列数增长出现这些性能问题 [54](#evidence-54)；`series_limit_per_user` 类错误会在部署引入新的坏标签后出现 [69](#evidence-69)。

### 中国云厂商（阿里云 ARMS Prometheus、腾讯云 TMP、华为云 AOM）

**本证据库中完全没有覆盖。** 这不是“它们没有相应能力”的否定结论，而是**证据覆盖缺口**：检入的厂商文档全部来自 AWS、Azure、GCP、Grafana，没有任何一篇涉及上述三家。任何关于它们的对比结论都缺乏依据，需要另行取证。

### 对比小结

| 能力 | AWS AMP | Azure | GCP | Grafana Cloud |
|---|---|---|---|---|
| 活跃序列硬配额/上限 | 有，可细化到标签集 [58](#evidence-58)[13](#evidence-13) | 以利用率形式监控 [14](#evidence-14) | 定义变更速率限流 [12](#evidence-12) | 按活跃序列计量 [69](#evidence-69) |
| churn 专项机制 | 无（推断） | 无（推断） | **每分钟新建指标/标签限流** [12](#evidence-12) | 有（churn 诊断流程 + Adaptive Metrics）[69](#evidence-69)[6](#evidence-6) |
| 基数可观测性 | 需自建查询/告警 [13](#evidence-13) | **内建 Active TS% 指标** [14](#evidence-14) | Metrics Management 页面 [65](#evidence-65) | 内建 cardinality 仪表盘 [71](#evidence-71) |
| 自动/摄入后聚合 | 建议自建侧 recording rules [44](#evidence-44) | recording rules [45](#evidence-45) | 本地聚合 [66](#evidence-66) | Adaptive Metrics [11](#evidence-11) |
| 计量是否被 churn 放大 | 是：样本 + 标签元数据按天 [15](#evidence-15) | 是：摄入 + 查询 [63](#evidence-63) | 是：字节/样本摄入 [65](#evidence-65) | 是：Active Series + DPM [69](#evidence-69) |

表中“是否被 churn 放大”一行是**基于计量规则的推断**：四家都按摄入量或活跃序列计量，而 churn 同时增加两者，但没有任何一家用 churn 描述自己的计价逻辑。

---

## 6. 建议的落地顺序

1. **本周**：接上 churn 三件套告警——`rate(created)`/`rate(removed)` 差值、`head_series` 与 `changes(app_build_info[1d])` 的叠加、WAL 峰值是否逐周期抬升 [19](#evidence-19)[20](#evidence-20)。同时检查 `restart` 策略是否在掩盖 OOMKill，把“一天内多次 WAL replay”设为告警 [24](#evidence-24)。
2. **本月**：把 `version`/`git_sha`/`image_tag` 从所有指标上摘掉，改 info-metric；`pod` 保留 [6](#evidence-6)。给所有 ServiceMonitor 设 `sampleLimit`/`targetLimit`/`labelLimit` 作为断路器，但先按“从不被查询的指标直接 drop”减浪费 [43](#evidence-43)[7](#evidence-7)。
3. **季度**：path/URL 模板化、request_id 类标签移入日志与 trace [5](#evidence-5)[39](#evidence-39)；为高频高基数查询建 recording rules [44](#evidence-44)[45](#evidence-45)；histogram 密集的场景评估 native histograms [8](#evidence-8)。
4. **架构评审时**：若 head 内存始终是瓶颈，评估 agent 模式/纯 remote-write（彻底取消本地 head）[9](#evidence-9)，接受失去本地规则求值的代价 [51](#evidence-51)；或评估托管 Mimir 类后端，但不要沿用 Prometheus 的 sizing 公式 [54](#evidence-54)[9](#evidence-9)。
5. **治理**：把“新标签的值集是否有界、是否只用于聚合”做成上线前评审项，并给每个团队一个明确的基数上限。**注意：最后这条“基数预算”是建议，不是有来源支撑的既有实践。**

---

## 7. 证据强度与限制

- **强证据**：churn 的定义与观测方式、head 内存与序列数的关系、`retention.size` 不封顶 RAM、限额的失败语义、`labeldrop` 破坏唯一性、recording rules / native histograms / agent 模式的定位。这些来自 Prometheus 官方文档、云厂商一手文档与 Grafana 的运维手册。
- **中等证据（推断）**：churn 如何具体放大各家云账单。厂商计量规则是一手的，但“churn 让账单涨”这一步是我基于计量维度的推理，没有厂商原文表述。跨厂商“谁更抗 churn”的排序也缺乏基准测试支撑。
- **明确的空白**：**没有 bytes-per-active-series 的权威常数或基准数据**，因此本报告不给出内存估算公式，只说“按活跃序列数 sizing”这一原则及其出处。另外，**没有任何来源记录 Thanos/Cortex/VictoriaMetrics 之间的 churn 容忍度对比**，所以我不排序。中国三家云厂商完全未被覆盖，这是覆盖缺口而非否定结论。
- 部分来源是技术博客与厂商维护的“skill”文档而非规范文本，我在引用时已按“运维经验”而非“标准”对待（例如 churn 症状表 [3](#evidence-3)、内存 sizing 的实测反思 [24](#evidence-24)[31](#evidence-31)）。

## Evidence

<a id="evidence-1"></a>

### 1. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 2486–3322

> The second case is **series churn**: label combinations appear and disappear rapidly, forcing Prometheus to keep creating new series identities and updating index structures even if the active-series count at any instant does not look catastrophic [E4](#ref-e4).
> 
> A few examples make the difference clearer:
> 
> *   **steady-state heavy**: a large fleet exposing many bounded-but-combinatorial dimensions
> *   **churn heavy**: labels that encode ephemeral pods, job IDs, request IDs, temporary paths, or short-lived task names
> 
> These failure modes overlap, but they are not the same. High steady-state cardinality mostly keeps memory pressure elevated. High churn adds continuous creation and teardown work on top of that, which can make ingestion more unstable even when dashboards only show a moderate number of live series [E3](#ref-e4).

<a id="evidence-2"></a>

### 2. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 3324–4193

> If you treat churn as just “temporary cardinality,” you miss the operational cost of constantly manufacturing new series.
> 
> ## Why labels become memory and index pressure [​](#why-labels-become-memory-and-index-pressure)
> 
> The most important mental shift is that labels are not free descriptors. In Prometheus, they participate in series identity, and series identity has storage consequences [E1](#ref-e3).
> 
> The TSDB head keeps active series and recent samples in memory [E3](#ref-e3). That means the cost of cardinality is not only about sample payloads. It is also about all the per-series structures needed to keep those samples queryable and appendable. As active series count rises, head memory rises with it.
> 
> You do not need a deep implementation tour to reason correctly here. A conceptual model is enough:
> 
> *   more unique label sets means more distinct series

<a id="evidence-3"></a>

### 3. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 9541–10431

> | Pod rollouts emitting `pod` label | Churn spike aligns with deploy timing; affects pod-discovered scrapes |
> | `version` / `git_sha` / `image_tag` label on every metric | Churn spike on every deploy across many metrics |
> | Ephemeral hostnames in `instance` | Cloud autoscaling event timing |
> | Bug: dynamic label names | Churn climbs forever, never plateaus |
> | Application bug emitting fresh UUIDs as labels | Linear unbounded growth, no deploy correlation |
> 
> ### Memory impact of churn
> 
> ```promql
> # A churn-driven head block carries old series until tsdb compaction
> prometheus_tsdb_head_chunks
> go_memstats_heap_inuse_bytes{job="prometheus"}
> ```
> 
> Restarting Prometheus drops churned series but is not a fix. The fix is at the source.
> 
> ---
> 
> ## Common-Culprit Gallery
> 
> ### Histogram blowup
> 
> **Tell**: `*_bucket` metric at the top of `seriesCountByMetricName`. Multiplier ≈ 14×.
> 
> **Fix**:
> 1.

<a id="evidence-4"></a>

### 4. How to manage high cardinality metrics in Prometheus and Kubernetes

https://grafana.com/blog/2022/10/21/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes · retrieved 2026-11-22 · text offsets 4773–5573

> ## [](#alright-high-cardinality-is-a-symptom-of-the-environment-but)Alright, high cardinality is a symptom of the environment, but why does it matter?
> 
> An increase in cardinality means you now need more infrastructure and compute to store and process these time series. This in turn has a direct impact on how much you spend on your observability platform. Recently this has been top of mind for operators and centralized observability teams.
> 
> It also impacts the performance of your observability platform itself. As your database grows, so does the number of time series accessed on any given queries, which can radically slow down your system when you query or visualize the data.  Dashboards that are slow to load or queries that are slow to return data prolong MTTR when troubleshooting outages.

<a id="evidence-5"></a>

### 5. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 6658–7481

> They are the ones whose value set is unbounded or operationally meaningless for aggregation.
> 
> Prometheus guidance is clear that labels should have bounded cardinality and should support useful aggregation [E2](#ref-e6). In practice, the riskiest patterns include:
> 
> *   `user_id`
> *   `session_id`
> *   `request_id`
> *   raw URLs or paths
> *   free-form error messages
> *   full exception text
> *   ephemeral container or job identifiers exposed at overly fine granularity
> 
> These are bad not because uniqueness is morally wrong, but because they create new series identities that do not aggregate well and rarely answer stable operational questions.
> 
> Safer replacements are usually structural:
> 
> *   use templated routes like `/users/{id}` instead of raw paths
> *   bucket or classify outcomes instead of storing raw error strings

<a id="evidence-6"></a>

### 6. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 15400–16280

> │   │   └── Route to `adaptive-metrics` skill (post-ingest aggregation rules — the safe way)
> │   └── You want metric-by-metric DPM breakdown
> │       └── Route to `dpm-finder` skill
> │
> ├── It's a fixable application bug (unbounded label, debug metric in prod)
> │   ├── Short-term: drop the whole metric at scrape, OR aggregate via Adaptive Metrics
> │   └── Long-term: fix in code; route to `prometheus-label-strategy` for design guidance
> │
> ├── It's histogram cardinality
> │   ├── Reduce labels on the underlying histogram AT THE SOURCE (14× win per label)
> │   ├── Reduce bucket count if appropriate
> │   └── Consider native histograms for high-resolution latency
> │
> └── It's churn (deploy-driven)
>     ├── Stop EMITTING `version`/`git_sha`/`instance` from app code (use info-metric for version)
>     ├── Keep `pod` — never drop it; if pod-level series are too costly, use Adaptive Metrics

<a id="evidence-7"></a>

### 7. Configuration | Prometheus

https://prometheus.io/docs/prometheus/latest/configuration/configuration/ · retrieved 2026-11-22 · text offsets 25600–27900

> tatic_configs:
>   [ - <static_config> ... ]
> 
> # List of target relabel configurations.
> relabel_configs:
>   [ - <relabel_config> ... ]
> 
> # List of metric relabel configurations.
> metric_relabel_configs:
>   [ - <relabel_config> ... ]
> 
> # An uncompressed response body larger than this many bytes will cause the
> # scrape to fail. 0 means no limit. Example: 100MB.
> # This is an experimental feature, this behaviour could
> # change or be removed in the future.
> [ body_size_limit: <size> | default = 0 ]
> 
> # Per-scrape limit on the number of scraped samples that will be accepted.
> # If more than this number of samples are present after metric relabeling
> # the entire scrape will be treated as failed. 0 means no limit.
> [ sample_limit: <int> | default = 0 ]
> 
> # Limit on the number of labels that will be accepted per sample. If more
> # than this number of labels are present on any sample post metric-relabeling,
> # the entire scrape will be treated as failed. 0 means no limit.
> [ label_limit: <int> | default = 0 ]
> 
> # Limit on the length (in bytes) of each individual label name. If any label
> # name in a scrape is longer than this number post metric-relabeling, the
> # entire scrape will be treated as failed. Note that label names are UTF-8
> # encoded, and characters can take up to 4 bytes. 0 means no limit.
> [ label_name_length_limit: <int> | default = 0 ]
> 
> # Limit on the length (in bytes) of each individual label value. If any label
> # value in a scrape is longer than this number post metric-relabeling, the
> # entire scrape will be treated as failed. Note that label values are UTF-8
> # encoded, and characters can take up to 4 bytes. 0 means no limit.
> [ label_value_length_limit: <int> | default = 0 ]
> 
> # Limit per scrape config on number of unique targets that will be
> # accepted. If more than this number of targets are present after target
> # relabeling, Prometheus will mark the targets as failed without scraping them.
> # 0 means no limit. This is an experimental feature, this behaviour could
> # change in the future.
> [ target_limit: <int> | default = 0 ]
> 
> # Limit per scrape config on the number of targets dropped by relabeling
> # that will be kept in memory. 0 means no limit.
> [ keep_dropped_targets: <int> | default = 0 ]
> 
> # Specifies the validation scheme for metric and label names. Either blank or
> # "u

<a id="evidence-8"></a>

### 8. The Zen of Prometheus | Prometheus

https://prometheus.io/docs/practices/the_zen/ · retrieved 2026-11-22 · text offsets 5213–6008

> Whenever you log an event, consider counting it by broad category. This is cheap and gives you alerting on elevated error rates plus an overview of what is happening. Remember, a metric without labels is cheap—spread counters liberally.
> 
> ## Native histograms are almost always better than classic histograms[](#native-histograms-are-almost-always-better-than-classic-histograms)
> 
> [Native histograms](/docs/specs/native_histograms/) solve the bucket layout problem of classic histograms. They require no predefined boundaries, adjust resolution dynamically, and use sparse representation where empty buckets cost nothing. If your instrumentation library or OTel supports them, prefer native histograms for new instrumentation.
> 
> With classic histograms, creating a correct bucket layout is an art.

<a id="evidence-9"></a>

### 9. Prometheus TSDB memory sizing — why observability services need different budgets

https://brandonwie.dev/posts/prometheus-tsdb-memory-sizing · retrieved 2026-11-22 · text offsets 10964–11829

> Every incident after that point gets diagnosed blind, which is why I would now cut Grafana, Loki, or Tempo before cutting Prometheus if the host is short on memory.
> 
> ## [When this applies, and when it does not](#when-this-applies-and-when-it-does-not)
> 
> This sizing logic fits any Docker Compose or Kubernetes deployment of upstream Prometheus. It matters most on home-lab and NAS stacks following the LGTM pattern, since those are the ones where memory is tight enough that someone is tempted to trim it.
> 
> It does not transfer cleanly to VictoriaMetrics or Mimir, which have different storage engines and different memory profiles. Thanos and Cortex federated setups are their own conversation, since the per-shard profile changes. And Prometheus in agent mode or a remote-write-only configuration keeps no local head block at all, so the whole question goes away.

<a id="evidence-10"></a>

### 10. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 890–1768

> # Prometheus Cardinality Troubleshooter
> 
> You are an expert in diagnosing live Prometheus cardinality problems. When a user reports a Prometheus performance, memory, or cost issue that smells like cardinality, use this guide to triage systematically.
> 
> This skill is **diagnostic and operational**. For schema design and prevention, route to `prometheus-label-strategy`.
> 
> ---
> 
> ## Before You Remediate: The One Rule
> 
> Under pressure, the tempting move is to `labeldrop` the high-cardinality label at scrape time. **Do not.** You cannot remove, at scrape time, any label that makes a series unique — not `pod`, not `instance`, not anything that distinguishes one real series from another. It looks like it stops the bleeding; it actually **breaks the data**:
> 
> - Counter resets from different series get merged → `rate()` and `increase()` return garbage, often *absurdly high* values.

<a id="evidence-11"></a>

### 11. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 11800–13000

> he user to `prometheus-label-strategy`. For series already in Grafana Cloud, **Adaptive Metrics** can aggregate `path` away correctly — route to `adaptive-metrics`.
> 
> Do **not** "normalize" `path` with a relabel `replacement` rule — collapsing `/users/123`, `/users/456`, … into one `/users/:id` value at scrape merges distinct series and produces duplicate-sample errors and broken `rate()`. The merge has to happen at the source (templating) or post-ingest (Adaptive Metrics), never at scrape.
> 
> If you must stop a production fire *right now* and templating isn't deployable yet, the only safe scrape-time action is to drop the **entire** offending metric (you lose it completely until the code fix lands — a deliberate trade, not a silent corruption):
> 
> ```yaml
> # Emergency: drop the whole metric until the source is templated
> metric_relabel_configs:
>   - source_labels: [__name__]
>     regex: http_requests_total
>     action: drop
> ```
> 
> ### Application emitting a debug metric in prod
> 
> **Tell**: A metric you don't recognize in the top 10. Grep the source — often a `_details` or `_per_request` debug metric the developer forgot to gate.
> 
> **Fix**: drop entirely at scrape:
> ```yaml
> metric_relabel_configs

<a id="evidence-12"></a>

### 12. Query-side problems

https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/troubleshooting · retrieved 2026-11-22 · text offsets 50197–51027

> If you see the following error, then you have hit the per-minute rate limit on
> creating new metrics and adding new metric labels to existing metrics:
> 
> - "Request throttled. You have hit the per-project limit on metric definition or label definition changes per minute."
> 
> This rate limit is usually only hit when first integrating with
> Managed Service for Prometheus, for example when you migrate an existing,
> mature Prometheus deployment to use self-deployed collection. **This
> is not a rate limit on ingesting data points**. This rate limit only applies
> when creating never-before-seen metrics or when adding new labels to existing
> metrics.
> 
> This quota is fixed, but any issues should automatically resolve
> as new metrics and metric labels get created up to the per-minute
> limit.
> 
> ### Limits on the number of metric descriptors

<a id="evidence-13"></a>

### 13. Best practices for migrating self-hosted Prometheus on Amazon EKS to Amazon Managed Service for Prometheus | Amazon Web Services

https://aws.amazon.com/blogs/opensource/best-practices-for-migrating-self-hosted-prometheus-on-amazon-eks-to-amazon-managed-service-for-prometheus · retrieved 2026-11-22 · text offsets 23500–26200

> tarted”](/blogs/mt/amazon-managed-grafana-getting-started/) to get started with AMG.
> 
> ![](https://d2908q01vomqb2.cloudfront.net/ca3512f4dfa95a03169c5a670a4c91a19b3077b4/2021/08/02/elamaras_prometheus_f3-1024x444.png)
> 
> #### Monitoring and managing the AMP service quotas
> 
> AMP has service quotas for the amount of data that a workspace can receive from Prometheus servers. For example, your `remote_write` API calls will get a 429 response error when requests exceed quotas on ingestion or number of active metrics in a workspace.
> 
> To proactively monitor and manage these quotas, you can run the following queries and set up Grafana dashboard alerts to receive notifications before a threshold value (for example, at 80 percent of limit) is reached. You can then request an increase in corresponding service quota. Additionally, you can query logs from Prometheus collectors to determine whether you reach service quota limits. These service quotas can be increased by opening a support ticket, unless there is a hard limit listed in the quota page for AMP. Refer to the [user guide](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html) for more service quota information for AMP. Read the [documentation for creating alerts](https://docs.aws.amazon.com/grafana/latest/userguide/create-alerts.html) to set up alerts in Grafana.
> 
> **Type of data**
> 
> **Query to use**
> 
> **Default AMP quota limit**
> 
> Current active series
> 
> `prometheus_tsdb_head_series`
> 
> 1,000,000
> 
> Current ingestion rate
> 
> `rate(prometheus_tsdb_head_samples_appended_total[5m])`
> 
> 70,000 samples/second
> 
> Most-to-least list of active series per metric name
> 
> `sort_desc(count by(__name__) ({__name__!=""}))`
> 
> 200,000
> 
> Number of labels per metric series
> 
> `group by(mylabelname) ({__name__ != ""})`
> 
> 70
> 
> ### Reliability
> 
> The [reliability pillar](https://wa.aws.amazon.com/wellarchitected/2020-07-02T19-33-23/wat.pillar.reliability.en.html) focuses on ensuring a workload performs its intended function correctly and consistently when it’s expected to. A resilient workload quickly recovers from failures to meet business and customer demand. Key topics include distributed system design, recovery planning, and how to handle change.
> 
> #### Ingestion, storage, and querying of metrics
> 
> The reliability pillar helps organizations prevent and quickly recover from failures to meet business and customer demand. AMP is designed to handle high-cardinality monitoring data with a large volume of tags (Prometheus labels) and dimensions generated by container-based applications.
> 
> AMP manages the operational complexity of elastically scaling the ingestion, storage, and querying of metrics. AMP is highly available and data ingested i

<a id="evidence-14"></a>

### 14. Best practices for scaling Azure Monitor Workspaces with Azure Monitor managed service for Prometheus - Azure Monitor | Microsoft Learn

https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/azure-monitor-workspace-scaling-best-practice · retrieved 2026-11-22 · text offsets 5104–5944

> For more information on limits and quotas, see [Azure Monitor service limits and quotas](../fundamentals/service-limits#prometheus-metrics).
> 
> Consider the following best practices for managing Azure Monitor workspace limits and quotas:
> 
> | Best practice | Description |
> | --- | --- |
> | Monitor and create an alert on ingestion limits and utilization. | In the Azure portal, navigate to your Azure Monitor Workspace. Go to Metrics and verify that the metrics Active Time Series % Utilization and Events Per Minute Ingested % Utilization are below 100%. Set an Azure Monitor Alert to monitor the utilization and fire when the utilization is greater than 80% of the limit. For more information on monitoring utilization and limits, see [How can I monitor the service limits and quotas](azure-monitor-workspace-monitor-ingest-limits). |

<a id="evidence-15"></a>

### 15. pricing

https://www.aws.eu/prometheus/pricing · retrieved 2026-11-22 · text offsets 2591–8460

> The monthly number of samples ingested is 892.8 million samples (10 nodes \* 1000 metrics per node / 30 collection interval in seconds \* 3,600 seconds in an hour \* 744 hours in a month = 10 \* 1000/30 \* 3,600 \* 744 = 892.8 million samples).
> 
> The monthly metrics ingested costs is €79.28 (€0.888/10,000,000 for the first 2 billion metric samples \* 892.8 million samples).
> 
> Storage usage and costs
> 
> Second, we will calculate the storage in GB and the costs for the metric samples and metric metadata stored. For this example, we will assume that you have 20 labels per metrics with 100 unique label values per label. The metadata including the metric name, labels, and label values are stored daily. We will also assume an average of 30 bytes per label and label value and 2 bytes per metric sample ingested.
> 
> The monthly GB of storage is 0.25 GB (metric metadata \* # of days per month) + (2 bytes \* number of metric samples = (1000 metrics \* 20 labels \* 100 label values \* 30 bytes \* ~30 days per month) + (2 bytes \* 892.8 million samples) = 1800 million bytes + 1,785.6 million bytes = 3,585.6 million bytes = 3.34 GB). The storage charge is €0.10 (€0.0296057265/GB \* 3.34 GB).
> 
> Query usage and costs
> 
> We will now calculate the query samples processed and query costs for this example. We will assume you have 1 end user monitoring a dashboard for an average of 2 hours per day refreshing it every 60 seconds with 20 chart widgets per dashboard (assuming 1 PromQL query per widget). We will assume for this example that the samples processed per query is 100,000.
> 
> First, start by calculating the count of queries per month which is 72,000 queries (1 end user \* 20 charts \* 2 hours of viewing a dashboard \* 3,600 seconds per hour / 60 seconds per dashboard refresh \* ~30 days in a month). Second, we calculate the query samples processed per month which is 7.2 billion (72,000 queries \* 100,000/query). We can now calculate the query charge of €0.72 (€0.10/billion samples processed \* 7.2 billion samples processed).
> 
> We can now calculate your monthly costs for this example:
> 
> *   Metric ingestion costs: €79.28 (€0.888/10M \* 892.8 million samples)
> *   Storage costs: €0.10 (€0.0296057265/GB \* 3.34 GB)
> *   Query costs: €0.72 (€0.10/billion samples processed \* 7.2 billion samples processed)
> 
> Total Monthly charges = €79.28 (metric ingestion) + €0.10 (storage) + €0.72 (query) = €80.10
> 
> ### Example 2 - Collecting Prometheus metrics from EKS with the AMP collector
> 
> In this example you are monitoring 1 Kubernetes cluster with 10 nodes with 1000 Prometheus metrics per node collected every 30 seconds by Amazon Managed Service for Prometheus collector for the entire month (744 hours). The following usage and costs will be calculated 1) metric sample ingestion, 2) storage, and 3) Amazon Managed Service for Prometheus collector samples collected and collector hours.
> 
> Metric sample ingestion usage and costs  
> First, we will calculate the number of metric samples ingested and the costs for these samples. The monthly number of samples ingested is 892.8 million samples (10 nodes \* 1000 metrics per node / 30 collection interval in seconds \* 3,600 seconds in an hour \* 744 hours in a month = 892.8 million samples).
> 
> The monthly metrics ingested costs is €79.28 (€0.888/10,000,000 for the first 2 billion metric samples \* 892.8 million samples).
> 
> Storage usage and costs  
> Second, we will calculate the storage in GB and the costs for the metric samples and metric metadata stored. For this example, we will assume that you have 20 labels per metrics with 100 unique label values per label. The metadata including the metric name, labels, and label values are stored daily. We will also assume an average of 30 bytes per label and label value and 2 bytes per metric sample ingested.
> 
> The monthly GB of storage is 0.25 GB (metric metadata \* # of days per month) + (2 bytes \* number of metric samples = (1000 metrics \* 20 labels \* 100 label values \* 30 bytes \* ~30 days per month) + (2 bytes \* 892.8 million samples) = 1800 million bytes + 1,785.6 million bytes = 3,585.6 million bytes = 3.34 GB). The storage charge is €0.10 (€0.0296057265/GB \* 3.34 GB).
> 
> Samples collected and collector hour costs  
> Third, we will calculate the collector hour costs. The agentless collector costs €0.039474302 per collector hour and €0.03 per 10M samples collected, and we assume a single collector for a single EKS cluster. Assuming 744 hours in a month, the monthly cost is: 1 \* €0.039474302 \* 744 + €0.03 \* 892.8 million samples / 10M = €32.05. The agentless collector charge is €32.05.
> 
> We can now calculate your monthly costs for this example:
> 
> Metric ingestion costs: €79.28 (€0.888/10M \* 892.8 million samples)  
> Storage costs: €0.10 (€0.0296057265/GB \* 3.34 GB)  
> The agentless collector costs: €32.05 (€0.039474302 per collector-hour \* 744 hours + €0.03 \* 892.8 million samples / 10M)  
> Total costs: €111.43 
> 
> ### Example 3 - Calculating Query Samples Processed (QSP) and costs
> 
> In this example, you are running a query to calculate the CPU of your 10,000 nodes in the last hour and an alerting rule running every minute to notify you when one of those nodes exceeds 80% CPU capacity. This example does not factor in your AWS Free Tier benefits. We will calculate the usage and costs of running the query and the alerting rule.
> 
> Query usage and cost  
> First, we calculate the number of samples a single query processes by identifying the number of metric time series and the provided time range. A metric time series is identified by its metric name and key-value pairs. In this example, each node has a single CPU metric resulting in a query that processes 10,000 metric time series for a 1 hour time range. Prometheus queries process one sample per resolution step, which is the minimum amount of time between any two data points.

<a id="evidence-16"></a>

### 16. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 840–1645

> Prometheus does not store “one metric with some tags attached.” It stores one time series per unique metric-and-label-set combination [E1](#ref-e1). If you add a label with 10 values to a metric that already has 20 combinations from other labels, you are not adding metadata. You are potentially multiplying the number of series.
> 
> That distinction matters because operators often reason in terms of metric names:
> 
> *   “we only added one new metric”
> *   “it is just one more label”
> *   “the sample rate did not change”
> 
> But the TSDB cares about distinct series identities. A counter like this:
> 
> *   `http_requests_total{method="GET",status="200"}`
> 
> is a different series from:
> 
> *   `http_requests_total{method="POST",status="200"}`
> 
> and both are different again if you add `route`, `instance`, or `tenant`.

<a id="evidence-17"></a>

### 17. Metric and label naming | Prometheus

https://prometheus.io/docs/practices/naming/ · retrieved 2026-11-22 · text offsets 5724–6591

> *   `api_request_duration_seconds` - differentiate request stages: `stage="extract|transform|load"`
> 
> Do not put the label names in the metric name, as this introduces redundancy and will cause confusion if the respective labels are aggregated away.
> 
> > **CAUTION**: Remember that every unique combination of key-value label pairs represents a new time series, which can dramatically increase the amount of data stored. Do not use labels to store dimensions with high cardinality (many different label values), such as user IDs, email addresses, or other unbounded sets of values.
> 
> ## Base Units[](#base-units)
> 
> Prometheus does not have any units hard coded. For better compatibility, base units should be used. The following lists some metrics families with their base unit. The list is not exhaustive.
> 
> Family
> 
> Base unit
> 
> Remark
> 
> Time
> 
> seconds
> 
> Temperature
> 
> celsius

<a id="evidence-18"></a>

### 18. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 1645–2484

> That is the core of cardinality: how many unique label combinations exist, not how compact the metric name looks [E1](#ref-e2).
> 
> This is also why cardinality hurts before retention becomes the main problem. Each additional active series adds metadata and in-memory bookkeeping in the head block, not just more bytes on disk later [E3](#ref-e3).
> 
> ## Steady-state cardinality and churn are different problems [​](#steady-state-cardinality-and-churn-are-different-problems)
> 
> Two Prometheus servers can both report “too many series” while suffering from different root causes.
> 
> The first case is **steady-state cardinality**: you simply have a large number of active series that persist over time. This often comes from valid-but-expensive dimensions such as `instance`, `pod`, `route`, `status`, and `method` interacting across many targets.

<a id="evidence-19"></a>

### 19. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 8722–9541

> # Active series correlated with build_info
> prometheus_tsdb_head_series
> # Overlay with:
> changes(app_build_info[1d])
> ```
> 
> A vertical step in series count aligned with a deploy is conclusive.
> 
> ---
> 
> ## Step 5: Churn Diagnosis
> 
> High churn means series are being created and abandoned faster than they age out. Symptoms: series count keeps climbing, then drops sharply on Prometheus restart.
> 
> ### Churn signal
> 
> ```promql
> # Series created vs. removed per second
> rate(prometheus_tsdb_head_series_created_total[5m])
> rate(prometheus_tsdb_head_series_removed_total[5m])
> 
> # Ratio of churned to live
> prometheus_tsdb_head_series_created_total / prometheus_tsdb_head_series
> ```
> 
> A creation rate that materially exceeds the removal rate, sustained, means cardinality is on a one-way trip up. Common causes:
> 
> | Cause | Tell |
> |---|---|

<a id="evidence-20"></a>

### 20. How to Diagnose Prometheus WAL Growth Before Disk Runs Out

https://oneuptime.com/blog/post/2026-11-15-how-to-diagnose-prometheus-wal-growth-before-disk-runs-out/view · retrieved 2026-11-22 · text offsets 1683–2571

> Looking only at numbered segment files can miss temporary overlap during checkpoint creation. Avoid a tight filesystem polling loop on an already overloaded disk.
> 
> ## Correlate growth with samples and series
> 
> A spike in sample rate suggests more ingestion. Rapid series creation with modest sample growth suggests churn, for example a request identifier accidentally promoted to a metric label. Both can increase resource demand, but their fixes differ.
> 
> ```promql
> rate(prometheus_tsdb_head_samples_appended_total[15m])
> ```
> 
> ```promql
> rate(prometheus_tsdb_head_series_created_total[15m])
> ```
> 
> Also inspect Prometheus logs for head compaction failures, checkpoint errors, disk latency, and permission problems. A growing WAL plus repeated compaction failure is stronger evidence than disk growth alone. Check whether the latest normal blocks are appearing without moving or deleting them.

<a id="evidence-21"></a>

### 21. HTTP API | Prometheus

https://prometheus.io/docs/prometheus/latest/querying/api · retrieved 2026-11-22 · text offsets 64000–69500

> ollowing endpoint returns various cardinality statistics about the Prometheus TSDB:
> 
> ```
> GET /api/v1/status/tsdb
> ```
> 
> URL query parameters:
> 
> *   `limit=<number>`: Limit the number of returned items to a given number for each set of statistics. By default, 10 items are returned. The maximum allowed limit is 10000.
> 
> The `data` section of the query result consists of:
> 
> *   **headStats**: This provides the following data about the head block of the TSDB:
>     *   **numSeries**: The number of series.
>     *   **chunkCount**: The number of chunks.
>     *   **minTime**: The current minimum timestamp in milliseconds.
>     *   **maxTime**: The current maximum timestamp in milliseconds.
> *   **seriesCountByMetricName:** This will provide a list of metrics names and their series count.
> *   **labelValueCountByLabelName:** This will provide a list of the label names and their value count.
> *   **memoryInBytesByLabelName** This will provide a list of the label names and memory used in bytes. Memory usage is calculated by adding the length of all values for a given label name.
> *   **seriesCountByLabelPair** This will provide a list of label value pairs and their series count.
> 
> ```
> curl http://localhost:9090/api/v1/status/tsdb
> ```
> 
> ```
> {
>   "status": "success",
>   "data": {
>     "headStats": {
>       "numSeries": 508,
>       "chunkCount": 937,
>       "minTime": 1591516800000,
>       "maxTime": 1598896800143,
>     },
>     "seriesCountByMetricName": [
>       {
>         "name": "net_conntrack_dialer_conn_failed_total",
>         "value": 20
>       },
>       {
>         "name": "prometheus_http_request_duration_seconds_bucket",
>         "value": 20
>       }
>     ],
>     "labelValueCountByLabelName": [
>       {
>         "name": "__name__",
>         "value": 211
>       },
>       {
>         "name": "event",
>         "value": 3
>       }
>     ],
>     "memoryInBytesByLabelName": [
>       {
>         "name": "__name__",
>         "value": 8266
>       },
>       {
>         "name": "instance",
>         "value": 28
>       }
>     ],
>     "seriesCountByLabelValuePair": [
>       {
>         "name": "job=prometheus",
>         "value": 425
>       },
>       {
>         "name": "instance=localhost:9090",
>         "value": 425
>       }
>     ]
>   }
> }
> ```
> 
> _New in v3.6.0_
> 
> ### TSDB Blocks[](#tsdb-blocks)
> 
> **NOTE**: This endpoint is **experimental** and might change in the future. The endpoint name and the exact format of the returned data may change between Prometheus versions. The **exact metadata returned** by this endpoint is an implementation detail and may change in future Prometheus versions.
> 
> The following endpoint returns the list of currently loaded TSDB blocks and their metadata.
> 
> ```
> GET /api/v1/status/tsdb/blocks
> ```
> 
> This endpoint returns the following information for each block:
> 
> *   `ulid`: Unique ID of the block.
> *   `minTime`: Minimum timestamp (in milliseconds) of the block.
> *   `maxTime`: Maximum timestamp (in milliseconds) of the block.
> *   `stats`:
>     *   `numSeries`: Number of series in the block.
>     *   `numSamples`: Number of samples in the block.
>     *   `numChunks`: Number of chunks in the block.
> *   `compaction`:
>     *   `level`: The compaction level of the block.
>     *   `sources`: List of ULIDs of source blocks used to compact this block.
> *   `version`: The block version.
> 
> ```
> curl http://localhost:9090/api/v1/status/tsdb/blocks
> ```
> 
> ```
> {
>   "status": "success",
>   "data": {
>     "blocks": [
>       {
>         "ulid": "01JZ8JKZY6XSK3PTDP9ZKRWT60",
>         "minTime": 1750860620060,
>         "maxTime": 1750867200000,
>         "stats": {
>           "numSamples": 13701,
>           "numSeries": 716,
>           "numChunks": 716
>         },
>         "compaction": {
>           "level": 1,
>           "sources": [
>             "01JZ8JKZY6XSK3PTDP9ZKRWT60"
>           ]
>         },
>         "version": 1
>       }
>     ]
>   }
> }
> ```
> 
> _New in v2.15_
> 
> ### WAL Replay Stats[](#wal-replay-stats)
> 
> The following endpoint returns information about the WAL replay:
> 
> ```
> GET /api/v1/status/walreplay
> ```
> 
> *   **read**: The number of segments replayed so far.
> *   **total**: The total number segments needed to be replayed.
> *   **progress**: The progress of the replay (0 - 100%).
> *   **state**: The state of the replay. Possible states:
>     *   **waiting**: Waiting for the replay to start.
>     *   **in progress**: The replay is in progress.
>     *   **done**: The replay has finished.
> 
> ```
> curl http://localhost:9090/api/v1/status/walreplay
> ```
> 
> ```
> {
>   "status": "success",
>   "data": {
>     "min": 2,
>     "max": 5,
>     "current": 40,
>     "state": "in progress"
>   }
> }
> ```
> 
> > **NOTE**: This endpoint is available before the server has been marked ready and is updated in real time to facilitate monitoring the progress of the WAL replay.
> 
> _New in v2.28_
> 
> ### Self Metrics[](#self-metrics)
> 
> **NOTE**: This endpoint is **experimental** and might change in the future.
> 
> The following endpoint returns Prometheus' own instrumentation metrics from its internal client registry as structured JSON. These are the same metrics that are exposed on the `/metrics` endpoint in Prometheus text exposition format, but returned as JSON for programmatic access by the web UI.
> 
> The response uses the standard [ProtoJSON](https://protobuf.dev/programming-guides/json/)  representation of the `io.prometheus.client.MetricFamily` protocol buffer message.
> 
> ```
> GET /api/v1/status/self_metrics
> ```
> 
> URL query parameters:
> 
> *   `metric_name_pattern=<string>`: A regular expression filter for metric names (fully anchored, like PromQL label matchers). Only metric fami

<a id="evidence-22"></a>

### 22. promtool | Prometheus

https://prometheus.io/docs/prometheus/latest/command-line/promtool · retrieved 2026-11-22 · text offsets 10633–11524

> ### `promtool tsdb`[](#promtool-tsdb)
> 
> Run tsdb commands.
> 
> ##### `promtool tsdb bench`[](#promtool-tsdb-bench)
> 
> Run benchmarks.
> 
> ##### `promtool tsdb bench write`[](#promtool-tsdb-bench-write)
> 
> Run a write performance benchmark.
> 
> ###### Flags[](#flags-18)
> 
> Flag
> 
> Description
> 
> Default
> 
> `--out`
> 
> Set the output path.
> 
> `benchout`
> 
> `--metrics`
> 
> Number of metrics to read.
> 
> `10000`
> 
> `--scrapes`
> 
> Number of scrapes to simulate.
> 
> `3000`
> 
> ###### Arguments[](#arguments-14)
> 
> Argument
> 
> Description
> 
> Default
> 
> file
> 
> Input file with samples data, default is (../../tsdb/testdata/20kseries.json).
> 
> `../../tsdb/testdata/20kseries.json`
> 
> ##### `promtool tsdb analyze`[](#promtool-tsdb-analyze)
> 
> Analyze churn, label pair cardinality and compaction efficiency.
> 
> ###### Flags[](#flags-19)
> 
> Flag
> 
> Description
> 
> Default
> 
> `--limit`
> 
> How many items to show in each list.
> 
> `20`
> 
> `--extended`
> 
> Run extended analysis.

<a id="evidence-23"></a>

### 23. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 10070–10957

> *   [E2](#ref-e2) Prometheus explicitly warns that every unique labelset is a new time series and advises keeping cardinality low because labels with many values can dramatically increase RAM, CPU, disk, and network usage. — [https://prometheus.io/docs/practices/instrumentation/](https://prometheus.io/docs/practices/instrumentation/)
> *   [E3](#ref-e3) The Prometheus TSDB head keeps active series and recent samples in memory, so large active series counts increase memory usage before long-term block storage becomes the limiting factor. — [https://github.com/prometheus/prometheus/tree/main/tsdb/docs](https://github.com/prometheus/prometheus/tree/main/tsdb/docs)
> *   [E4](#ref-e4) Series churn is operationally expensive because creating many short-lived time series repeatedly forces ongoing series creation and indexing work, not just growth in the current active-series snapshot.

<a id="evidence-24"></a>

### 24. Prometheus TSDB memory sizing — why observability services need different budgets

https://brandonwie.dev/posts/prometheus-tsdb-memory-sizing · retrieved 2026-11-22 · text offsets 10222–10964

> `restart: unless-stopped` is genuinely useful and it does hide capacity problems. Without it, an OOM would have been loud: a dead container, a gap in dashboards, an alert. With it, the container cycles and the surface reading stays green. Checking `docker logs` for WAL replay messages on startup is a cheap habit, since a Prometheus that replays its WAL more than once a day is telling you something.
> 
> Series count is what moves the memory number. Worker metrics with per-URL or per-user labels grow it in a way that scrape volume never does, and each series costs RAM in the head block continuously rather than per request.
> 
> The one that changed how I prioritize things: losing Prometheus is worse than losing any single service it watches.

<a id="evidence-25"></a>

### 25. Prometheus TSDB memory sizing — why observability services need different budgets

https://brandonwie.dev/posts/prometheus-tsdb-memory-sizing · retrieved 2026-11-22 · text offsets 11831–12705

> ## [Practical takeaway](#practical-takeaway)
> 
> Prometheus is the one service in an observability stack that is a database, and the head block it keeps in RAM is what your memory limit has to cover. Size it from the number of live series, not from what the container next to it in the Compose file happens to be using.
> 
> ## [References](#references)
> 
> *   [Storage — Prometheus documentation](https://prometheus.io/docs/prometheus/latest/storage/#operational-aspects) — the current block is kept in memory and secured by a WAL, plus the semantics of `--storage.tsdb.retention.time` and `--storage.tsdb.retention.size` and the disk-sizing formula
> *   [Do not overuse labels — Instrumentation | Prometheus](https://prometheus.io/docs/practices/instrumentation/#do-not-overuse-labels) — every labelset is another time series with a RAM cost, and the suggested cardinality ceilings

<a id="evidence-26"></a>

### 26. Prometheus TSDB memory sizing — why observability services need different budgets

https://brandonwie.dev/posts/prometheus-tsdb-memory-sizing · retrieved 2026-11-22 · text offsets 8505–9361

> What the docs give is disk sizing: an average of 1-2 bytes per sample, and the formula `needed_disk_space = retention_time_seconds * ingested_samples_per_second * bytes_per_sample`. There is no equivalent memory formula on that page. So 2 GB was a headroom choice informed by observed baselines, not a documented requirement, and I had filed it in my head as more authoritative than it was.
> 
> Second, `--storage.tsdb.retention.size=1GB` does less than I originally credited it with. I filed it as a belt-and-suspenders guard against runaway head growth. The docs are specific that it is not: “Only the persistent blocks are deleted to honor this retention although WAL and m-mapped chunks are counted in the total size.” It bounds disk, and it bounds how much a cardinality explosion can accumulate on disk over time. It does not cap the head block in RAM.

<a id="evidence-27"></a>

### 27. How to Diagnose Prometheus WAL Growth Before Disk Runs Out

https://oneuptime.com/blog/post/2026-11-15-how-to-diagnose-prometheus-wal-growth-before-disk-runs-out/view · retrieved 2026-11-22 · text offsets 0–871

> # How to Diagnose Prometheus WAL Growth Before Disk Runs Out
> 
> Separate normal Prometheus WAL peaks from ingestion churn, stalled compaction, and remote-write lag before persistent storage fills.
> 
> - Published: 2026-11-15
> - Author: [Nawaz Dhandala](https://github.com/nawazdhandala)
> - Tags: Prometheus, Storage, Monitoring
> - Canonical: https://oneuptime.com/blog/post/2026-11-15-how-to-diagnose-prometheus-wal-growth-before-disk-runs-out/view
> 
> ---
> 
> The Prometheus write-ahead log is expected to grow between cleanup events. The useful question is whether its peak is rising across comparable cycles, not whether the directory is larger than it was five minutes ago. Start by separating a normal sawtooth pattern from sustained growth and by confirming which process owns the volume.
> 
> This investigation assumes Prometheus 3.x in server mode on a supported local filesystem.

<a id="evidence-28"></a>

### 28. How to Diagnose Prometheus WAL Growth Before Disk Runs Out

https://oneuptime.com/blog/post/2026-11-15-how-to-diagnose-prometheus-wal-growth-before-disk-runs-out/view · retrieved 2026-11-22 · text offsets 4276–5175

> Raising queue capacity or shard count blindly can increase memory pressure and trigger restarts without solving disk growth. Review receiver throughput and local CPU before tuning.
> 
> Do not remove live WAL files as routine cleanup. That can discard recent data and interfere with recovery. Time-based block retention is also not a direct WAL-size control. Prefer adding emergency headroom, reverting an accidental high-cardinality scrape, or repairing a proven compaction failure. After the intervention, verify multiple peak-to-peak cycles, successful checkpoints, and remote freshness. Preserve the original measurements so the next capacity review uses the corrected workload rather than the incident spike.
> 
> ## References
> 
> The [community question](https://stackoverflow.com/questions/63958695/prometheus-wal-keeps-on-growing-indefinitely) motivated this walkthrough. Implementation references:

<a id="evidence-29"></a>

### 29. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 9263–10070

> *   churn creates work even when steady-state graphs look calm
> *   aggregation does not make a wide query cheap
> 
> Prometheus can handle a lot, but it is brutally honest about what you ask it to index and query. Cardinality is the bill for turning labels into series identities. If you understand where that bill is paid—in head memory, index work, churn overhead, and query fan-out—you can design metrics that stay useful without making the server fragile.
> 
> ## References [​](#references)
> 
> *   [E1](#ref-e1) In Prometheus, each unique combination of metric name and labels defines a distinct time series, so adding label dimensions multiplies series count rather than merely annotating an existing metric. — [https://prometheus.io/docs/concepts/data\_model/](https://prometheus.io/docs/concepts/data_model/)

<a id="evidence-30"></a>

### 30. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 2659–3439

> Everywhere below that says "drop a label," read it through this rule: drop whole metrics, fix the source, or use Adaptive Metrics — never `labeldrop` a distinguishing label.
> 
> ---
> 
> ## Symptom → Likely Cause
> 
> | Symptom | Likely Cause | First Action |
> |---|---|---|
> | Prometheus OOMKilled or memory growing linearly | Active series growth (often from a new bad metric or label) | [Active Series triage](#step-1-active-series-triage) |
> | Single PromQL query slow or OOMs the querier | One or more metrics in the query have high cardinality | [Per-query drill-down](#step-3-per-metric-drill-down) |
> | Remote write lagging, WAL growing | Sample throughput spike — series count OR scrape interval changed | [Active Series triage](#step-1-active-series-triage) + check scrape intervals |

<a id="evidence-31"></a>

### 31. Prometheus TSDB memory sizing — why observability services need different budgets

https://brandonwie.dev/posts/prometheus-tsdb-memory-sizing · retrieved 2026-11-22 · text offsets 4229–5090

> Snapshot it at the wrong moment and the container reads healthy, because it really is running most of the time. The two signals that were actually telling the truth were WAL replay messages in `docker logs` on every start, and scrape gaps visible in Grafana. The second one is the ironic part, since the service whose job is to notice outages was the one having them.
> 
> ## [What tipped it over was cardinality, not traffic](#what-tipped-it-over-was-cardinality-not-traffic)
> 
> If a baseline sits comfortably under the cap, what pushes it over? Sizing web services had trained me to look at request volume, which turns out to be the wrong variable here. What matters is anything that creates new time series:
> 
> *   A service emitting metrics with high-cardinality labels such as per-user, per-URL, or per-record-id
> *   A new scrape target being added to the config

<a id="evidence-32"></a>

### 32. How to manage high cardinality metrics in Prometheus and Kubernetes

https://grafana.com/blog/2022/10/21/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes · retrieved 2026-11-22 · text offsets 2341–3142

> Consider the kube\_pod\_status\_phase metric (one of the kube-state-metrics), which generates a new time series each time a pod changes state, say from “pending” to “running” to “failed” or “succeeded.” Depending on the rate of cluster events, especially with a lot of short running jobs, tracking a single pod’s status alone could generate a lot of metrics.
> 
> The ease of instrumentation and autonomy created through a microservices architecture sometimes can result in an increase in cardinality as well. With a rich set of open source exporters out there, as well as client libraries for 15+ programming languages, it’s never been easier to instrument your application to expose Prometheus metrics.  With each team empowered to add metrics to their application, governance becomes more challenging.

<a id="evidence-33"></a>

### 33. How to manage high cardinality metrics in Prometheus and Kubernetes

https://grafana.com/blog/2022/10/21/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes · retrieved 2026-11-22 · text offsets 3962–4771

> For example, the Prometheus Node exporter, which provides hardware and OS-level system metrics, emits roughly 500 Prometheus time series by default. The mySQL exporter publishes roughly 1,000 time series and not all of those are valuable.
> 
> No matter the environment, one of the most common mistakes we see is the use of sub-optimal labels in metrics databases. Since cardinality is a cartesian product of two sets (metrics and labels), how labels are defined goes a long way in keeping cardinality under control. If labels that are randomly generated and have no upper limit of unique values are used (for example, if `{session_id}` generated with every new connection), then the number of time series could spike when traffic to the system increases. The same could be said for `{user_id}` or `{device_id}`.

<a id="evidence-34"></a>

### 34. Query-side problems

https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/troubleshooting · retrieved 2026-11-22 · text offsets 46723–47613

> A less common cause of time-series collisions is using a scrape interval shorter
> than 5 seconds. The minimum scrape interval supported by
> Managed Service for Prometheus is 5 seconds.
> 
> ### Exceeding the limit on the number of labels
> 
> If you see the following error, then you might have too many labels defined for
> one of your metrics:
> 
> - "One or more TimeSeries could not be written: The new labels would cause the metric `prometheus.googleapis.com/METRIC_NAME` to have over <var translate="no">PER_PROJECT_LIMIT</var> labels".
> 
> This error usually occurs when you rapidly change the definition of the metric
> so that one metric name effectively has multiple independent sets of label keys
> over the whole lifetime of your metric. The Cloud Monitoring imposes a limit
> on number of labels for each metric; for more information see the limits for
> [user-defined metrics](https://docs.cloud.google.

<a id="evidence-35"></a>

### 35. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 12200–14511

> e has to happen at the source (templating) or post-ingest (Adaptive Metrics), never at scrape.
> 
> If you must stop a production fire *right now* and templating isn't deployable yet, the only safe scrape-time action is to drop the **entire** offending metric (you lose it completely until the code fix lands — a deliberate trade, not a silent corruption):
> 
> ```yaml
> # Emergency: drop the whole metric until the source is templated
> metric_relabel_configs:
>   - source_labels: [__name__]
>     regex: http_requests_total
>     action: drop
> ```
> 
> ### Application emitting a debug metric in prod
> 
> **Tell**: A metric you don't recognize in the top 10. Grep the source — often a `_details` or `_per_request` debug metric the developer forgot to gate.
> 
> **Fix**: drop entirely at scrape:
> ```yaml
> metric_relabel_configs:
>   - source_labels: [__name__]
>     regex: my_app_request_details
>     action: drop
> ```
> 
> Open a ticket against the team to remove it from the code.
> 
> ### App-emitted labels colliding with target labels
> 
> **Tell**: Series count for one job is several × what it should be. Looking at one series, you see both an app-emitted `instance=...` AND the target `instance=...` collided into something weird (Prometheus renames the conflicting one to `exported_instance`).
> 
> **Fix**: the right fix is **in the application** — stop emitting `instance`/`node`/`host` from code; they belong to the scrape target. Confirm `honor_labels` is `false` (the default) so the target labels win.
> 
> If you need a scrape-time stopgap, you may remove a label *only* where it **exactly duplicates** a target label — that's the one safe `labeldrop`, because the target label still provides uniqueness. Scope it tightly to the duplicated names and **never include `pod`** (or any other label that is the source of uniqueness):
> 
> ```yaml
> # Stopgap ONLY for app-emitted duplicates of target labels.
> # Drops the `exported_*` collisions — NOT pod, which makes K8s series unique.
> metric_relabel_configs:
>   - regex: exported_(instance|node|host)
>     action: labeldrop
> ```
> 
> Then the target labels from `relabel_configs` apply cleanly. Prefer fixing the app.
> 
> ### Federation amplifying cardinality
> 
> **Tell**: A federated Prometheus or Mimir global view has way more series than expected. Each source has its own `cluster` / `region` label, multiplying.

<a id="evidence-36"></a>

### 36. Configuration | Prometheus

https://prometheus.io/docs/prometheus/latest/configuration/configuration/ · retrieved 2026-11-22 · text offsets 194900–196800

> e_labels`. Then copy the values of the matching labels to label names given by `replacement` with match group references (`${1}`, `${2}`, ...) in `replacement` substituted by their value.
> *   `labeldrop`: Match `regex` against all label names. Any label that matches will be removed from the set of labels.
> *   `labelkeep`: Match `regex` against all label names. Any label that does not match will be removed from the set of labels.
> 
> Care must be taken with `labeldrop` and `labelkeep` to ensure that metrics are still uniquely labeled once the labels are removed.
> 
> ### `<metric_relabel_configs>`[](#metric_relabel_configs)
> 
> Metric relabeling is applied to samples as the last step before ingestion. It has the same configuration format and actions as target relabeling. Metric relabeling does not apply to automatically generated timeseries such as `up`.
> 
> One use for this is to exclude time series that are too expensive to ingest.
> 
> ### `<alert_relabel_configs>`[](#alert_relabel_configs)
> 
> Alert relabeling is applied to alerts before they are sent to the Alertmanager. It has the same configuration format and actions as target relabeling. Alert relabeling is applied after external labels.
> 
> One use for this is ensuring a HA pair of Prometheus servers with different external labels send identical alerts.
> 
> ### `<alertmanager_config>`[](#alertmanager_config)
> 
> An `alertmanager_config` section specifies Alertmanager instances the Prometheus server sends alerts to. It also provides parameters to configure how to communicate with these Alertmanagers.
> 
> Alertmanagers may be statically configured via the `static_configs` parameter or dynamically discovered using one of the supported service-discovery mechanisms.
> 
> Additionally, `relabel_configs` allow selecting Alertmanagers from discovered entities and provide advanced modifications to the used API path, which is exposed through the `__alerts

<a id="evidence-37"></a>

### 37. promtool | Prometheus

https://prometheus.io/docs/prometheus/latest/command-line/promtool · retrieved 2026-11-22 · text offsets 4418–5305

> ###### Arguments[](#arguments-4)
> 
> Argument
> 
> Description
> 
> rule-files
> 
> The rule files to check, default is read from standard input.
> 
> ##### `promtool check metrics`[](#promtool-check-metrics)
> 
> Pass Prometheus metrics over stdin to lint them for consistency and correctness, and optionally perform cardinality analysis.
> 
> examples:
> 
> $ cat metrics.prom | promtool check metrics
> 
> $ curl -s [http://localhost:9090/metrics](http://localhost:9090/metrics)  | promtool check metrics `--extended`
> 
> $ curl -s [http://localhost:9100/metrics](http://localhost:9100/metrics)  | promtool check metrics `--extended` `--lint`\=none
> 
> ###### Flags[](#flags-7)
> 
> Flag
> 
> Description
> 
> Default
> 
> `--extended`
> 
> Print extended information related to the cardinality of the metrics.
> 
> `--lint`
> 
> Linting checks to apply for metrics. Available options are: all, none. Use --lint=none to disable metrics linting.
> 
> `all`

<a id="evidence-38"></a>

### 38. How to manage high cardinality metrics in Prometheus and Kubernetes

https://grafana.com/blog/2022/10/21/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes · retrieved 2026-11-22 · text offsets 8224–9061

> To learn more about how to easily monitor cardinality with Grafana dashboards check out:
> 
> If you are a Grafana Cloud user and want to learn more about how metrics optimization, [contact us](/contact?pg=blog&plcmt=body-txt&aud=cost-opt).
> 
> #### [](#discover-unused-metrics)Discover unused metrics
> 
> [Mimirtool](/docs/mimir/latest/operators-guide/tools/mimirtool/?pg=blog&plcmt=body-txt) is an open source tool that can be used to identify metrics in Mimir, Prometheus, or Prometheus compatible databases that are not used in dashboards, alerts, or recording rules. Mimirtool is executed via command line and generates a JSON file with unused metrics.
> 
> Metrics that are unused entirely can be safely dropped, if not required for ad-hoc queries or future projects.
> 
> Learn more about using Mimirtool to identify unused metrics in these docs:

<a id="evidence-39"></a>

### 39. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 10400–12200

> Multiplier ≈ 14×.
> 
> **Fix**:
> 1. First, **reduce labels on the histogram at the source** — every label removed saves 14× series. Trim `path`, `method`, or `status_code` in the instrumentation code (don't `labeldrop` them at scrape — that merges distinct histograms and corrupts the buckets). For series already in Grafana Cloud you can't change, aggregate them with Adaptive Metrics.
> 2. Then, reduce bucket count if appropriate (custom buckets vs. defaults).
> 3. For high-resolution latency tracking, consider **native histograms** (Prometheus 2.40+) — single sparse series replaces the bucket family.
> 
> ### kube-state-metrics label explosion
> 
> **Tell**: `kube_pod_labels` or `kube_pod_annotations` at the top, with `label_*` or `annotation_*` labels driving cardinality.
> 
> **Fix**: configure kube-state-metrics with `--metric-labels-allowlist` and `--metric-annotations-allowlist`. By default it emits *all* labels and annotations as series.
> 
> ```yaml
> # kube-state-metrics flags
> --metric-labels-allowlist=pods=[app,team,version]
> --metric-annotations-allowlist=pods=[checksum/config]
> ```
> 
> ### Path / route blowup from a new endpoint
> 
> **Tell**: `http_requests_total` (or framework equivalent) grew 10×+ overnight. `topk(20, count by (path) (http_requests_total))` shows hundreds of `/users/123456`-style values.
> 
> **Fix**: the real fix is to **template the path in application code** (`/users/:id`) — route the user to `prometheus-label-strategy`. For series already in Grafana Cloud, **Adaptive Metrics** can aggregate `path` away correctly — route to `adaptive-metrics`.
> 
> Do **not** "normalize" `path` with a relabel `replacement` rule — collapsing `/users/123`, `/users/456`, … into one `/users/:id` value at scrape merges distinct series and produces duplicate-sample errors and broken `rate()`. The merg

<a id="evidence-40"></a>

### 40. The Hidden Cost of Cardinality in Prometheus: Labels, Churn, and Query Plans

https://blog.ipuau.com/en/posts/20240628-the-hidden-cost-of-cardinality-in-prometheus-labels-churn-and-query-plans.html · retrieved 2026-11-22 · text offsets 7481–8380

> *   move per-request or per-user detail into logs or traces instead of metrics
> *   keep labels for dimensions you actually plan to group, filter, or alert on [E6](#ref-e6)
> 
> A useful review question is: **if this label had 10x more values next month, would the metric still be operationally worth its cost?**
> 
> If the answer is no, the label probably does not belong in Prometheus.
> 
> ## Control cardinality before the server starts teaching you the lesson [​](#control-cardinality-before-the-server-starts-teaching-you-the-lesson)
> 
> The cheapest fix for cardinality is catching it before rollout. Once a large metric family is embedded across applications and dashboards, cleanup becomes slower and politically harder.
> 
> A practical review loop looks like this:
> 
> *   verify that every proposed label has a bounded value set
> *   ask whether the label is needed for aggregation or only for forensic lookup

<a id="evidence-41"></a>

### 41. Limit ServiceMonitor Cardinality with Sample, Target, and Label Limits

https://oneuptime.com/blog/post/2026-08-27-servicemonitor-cardinality-limits/view · retrieved 2026-11-22 · text offsets 0–891

> # Limit ServiceMonitor Cardinality with Sample, Target, and Label Limits
> 
> Apply ServiceMonitor sample, target, and label guardrails with correct failure semantics, version requirements, and capacity-planning measurements.
> 
> - Published: 2026-08-27
> - Author: [Nawaz Dhandala](https://github.com/nawazdhandala)
> - Tags: Prometheus, Prometheus Operator, ServiceMonitor, Cardinality, Metric, Reliability
> - Canonical: https://oneuptime.com/blog/post/2026-08-27-servicemonitor-cardinality-limits/view
> 
> ---
> 
> ---
> 
> ServiceMonitor limits protect Prometheus from unexpectedly large scrapes, target sets, and label payloads. They are circuit breakers, not silent truncation controls. When a configured threshold is exceeded, Prometheus fails targets or the whole scrape according to the limit.
> 
> A practical baseline looks like:
> 
> ```yaml
> apiVersion: monitoring.coreos.com/v1
> kind: ServiceMonitor
> metadata:

<a id="evidence-42"></a>

### 42. Limit ServiceMonitor Cardinality with Sample, Target, and Label Limits

https://oneuptime.com/blog/post/2026-08-27-servicemonitor-cardinality-limits/view · retrieved 2026-11-22 · text offsets 891–1639

> name: checkout
>   namespace: monitoring
> spec:
>   selector:
>     matchLabels:
>       app: checkout
>   sampleLimit: 12000
>   targetLimit: 100
>   labelLimit: 60
>   labelNameLengthLimit: 100
>   labelValueLengthLimit: 500
>   endpoints:
>     - port: metrics
> ```
> 
> The numbers are examples, not universal recommendations. Derive them from observed healthy behavior plus explicit headroom.
> 
> ## What Each Limit Measures
> 
> ### `sampleLimit`
> 
> `sampleLimit` is the maximum number of scraped samples accepted per scrape. Prometheus evaluates it after metric relabeling. If the response still contains more samples than the limit, the entire scrape fails. Prometheus does not keep the first N samples.
> 
> This protects against an exporter suddenly adding thousands of series.

<a id="evidence-43"></a>

### 43. Limit ServiceMonitor Cardinality with Sample, Target, and Label Limits

https://oneuptime.com/blog/post/2026-08-27-servicemonitor-cardinality-limits/view · retrieved 2026-11-22 · text offsets 5021–5861

> For example, `user_id` adds only one label to a sample and easily stays under `labelLimit`, but millions of values create millions of time series. No numeric label-count limit fixes that data-model choice.
> 
> ## Reduce Waste Before Setting the Breaker
> 
> Drop metrics that are never queried before applying a tight sample limit:
> 
> ```yaml
> spec:
>   sampleLimit: 12000
>   endpoints:
>     - port: metrics
>       metricRelabelings:
>         - action: drop
>           sourceLabels:
>             - __name__
>           regex: 'debug_.*|temporary_.*'
> ```
> 
> Metric relabeling runs before `sampleLimit`, so this reduces the evaluated sample count. It does not reduce bytes downloaded or exporter work. Prefer disabling unneeded collector families at the exporter when possible.
> 
> Use target relabeling or a narrower Service selector before relying on `targetLimit`.

<a id="evidence-44"></a>

### 44. Best practices for migrating self-hosted Prometheus on Amazon EKS to Amazon Managed Service for Prometheus | Amazon Web Services

https://aws.amazon.com/blogs/opensource/best-practices-for-migrating-self-hosted-prometheus-on-amazon-eks-to-amazon-managed-service-for-prometheus · retrieved 2026-11-22 · text offsets 17544–18375

> Do not use labels to store dimensions with high cardinality (many different label values), such as user IDs, email addresses, or other unbounded sets of values. Doing so may lead to way too many individual time series data points causing slower/unusable queries that cannot be visualized. For instance, you should not add high-cardinality labels such as `user_id` to your metric. If you do so, you’ll have hundreds of thousands of different time series, one for each user, and they will all have only one data point. [Recording rules](https://prometheus.io/docs/prometheus/latest/configuration/recording_rules/) can allow you to reduce the cardinality of metrics by pre-aggregating in your self-managed Prometheus server before sending the metrics to AMP.
> 
> #### Single Amazon VPC interface endpoint for multi-account environment

<a id="evidence-45"></a>

### 45. Best practices for scaling Azure Monitor Workspaces with Azure Monitor managed service for Prometheus - Azure Monitor | Microsoft Learn

https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/azure-monitor-workspace-scaling-best-practice · retrieved 2026-11-22 · text offsets 11807–12654

> This is especially useful for dashboards with multiple panels or high cardinality metrics.
> - **Simplicity** Recording rules simplify queries in Grafana or other visualization tools, as they can reference precomputed metrics.
> 
> The following example shows a recording rule as defined in Azure Managed Prometheus rule group:
> 
> ```yaml
> "record": "job:request_duration_seconds:avg ",
> "expression": "avg(rate(request_duration_seconds_sum[5m])) by (job)",
> "labels": {  "workload_type": "job"
>                         },
> "enabled": true
> ```
> 
> For more complex metrics, create recording rules that aggregate multiple metrics or perform more advanced calculations. In the following example, `instance:node_cpu_utilisation:rate5m` computes the cpu utilization when the cpu isn't idle
> 
> ```yaml
> "record": "instance:node_cpu_utilisation:rate5m",

<a id="evidence-46"></a>

### 46. Best practices for scaling Azure Monitor Workspaces with Azure Monitor managed service for Prometheus - Azure Monitor | Microsoft Learn

https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/azure-monitor-workspace-scaling-best-practice · retrieved 2026-11-22 · text offsets 12654–13505

> "expression": "1 - avg without (cpu) (sum without (mode)(rate(node_cpu_seconds_total{job=\"node\", mode=~\"idle|iowait|steal\"}[5m])))",
> "labels": {
>                             "workload_type": "job"
>                         },
> "enabled": true
> ```
> 
> Consider the following best practices for optimizing recording rules:
> 
> | Best practice | Description |
> | --- | --- |
> | Identify High Volume Metrics. | Focus on metrics that are queried frequently and have a high cardinality. |
> | Optimize Rule Evaluation Interval. | To balance between data freshness and computational load, adjust the evaluation interval of your recording rules. |
> | Monitor Performance. | Monitor query performance and adjust recording rules as necessary. |
> | Optimize rules by limiting scope. | To make recording rules faster, limit them in scope to a specific cluster.

<a id="evidence-47"></a>

### 47. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 14511–15400

> **Fix**: this is usually expected — federation by design preserves source labels. If the series count is too high, federate only aggregated recording rules, not raw metrics:
> 
> ```yaml
> - job_name: federate
>   honor_labels: true
>   metrics_path: /federate
>   params:
>     'match[]':
>       - '{__name__=~".*:.*"}'  # Recording-rule naming convention only
> ```
> 
> ---
> 
> ## Remediation Decision Tree
> 
> ```
> Cardinality fire confirmed
> │
> ├── Need to stop the bleeding NOW (production OOM, ingest 429s)
> │   └── Drop the ENTIRE offending metric via metric_relabel_configs (action: drop on __name__)
> │       (also applies to Alloy/Agent — same syntax)
> │       Do NOT labeldrop a distinguishing label — it breaks the data, see "The One Rule".
> │       Then schedule the proper fix.
> │
> ├── It's a Grafana Cloud Active Series bill issue, not a perf issue
> │   ├── Cardinality is structural and you can't fix the app

<a id="evidence-48"></a>

### 48. How to manage high cardinality metrics in Prometheus and Kubernetes

https://grafana.com/blog/2022/10/21/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes · retrieved 2026-11-22 · text offsets 12485–13375

> url=https%3A%2F%2Fs3.amazonaws.com%2Fa-us.storyblok.com%2Ff%2F1022730%2F5acff635da%2Fgrafana-dashboard-histograms-cardinality.png&w=3840&q=75)
> 
> You can safely drop the metrics series for buckets that are not needed. This will not result in data loss as the buckets are cumulative. For example, if you drop the “less than or equal to 10” bucket, these values will simply be included in the “less than or equal to 25” bucket. If this level of dimensionality is not required, you can safely drop the 10 value for the `le` label.
> 
> Below is an example of a relabel configuration:
> 
> ```
> # drop all metric series ending with _bucket and where le="10"
> - source_labels: [__name__, le]
>   separator: _
>   regex: ".+_bucket_10"
>   action: "drop"
> ```
> 
> To learn more about reducing Prometheus metrics usage and relabel configuration, take a look at our documentation:
> 
> #### [](#reduce-labels)Reduce labels

<a id="evidence-49"></a>

### 49. Prometheus TSDB memory sizing — why observability services need different budgets

https://brandonwie.dev/posts/prometheus-tsdb-memory-sizing · retrieved 2026-11-22 · text offsets 5979–6860

> I had read that advice as being about large fleets. It applies just as well to one worker on a NAS, because the resource it spends is the same resource the head block needs.
> 
> ## [The knobs, and which two I turned](#the-knobs-and-which-two-i-turned)
> 
> There are more ways out of this than “raise the number,” and they trade off against different things:
> 
> Option
> 
> What it costs
> 
> Raise `mem_limit`
> 
> Host RAM, taken from other containers on the same box
> 
> Increase the scrape interval
> 
> Resolution: 15s to 60s loses detail on short-lived spikes
> 
> Drop scrape targets
> 
> Coverage, which is the thing the stack exists to provide
> 
> Shorten `--storage.tsdb.retention.time`
> 
> History for after-the-fact debugging
> 
> Cap `--storage.tsdb.retention.size`
> 
> Nothing much, until it starts silently dropping old blocks
> 
> Remove high-cardinality labels
> 
> Nothing, if the labels were not being queried anyway

<a id="evidence-50"></a>

### 50. Best practices for scaling Azure Monitor Workspaces with Azure Monitor managed service for Prometheus - Azure Monitor | Microsoft Learn

https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/azure-monitor-workspace-scaling-best-practice · retrieved 2026-11-22 · text offsets 9286–10136

> For information on customizing collection, see [Customize scraping of Prometheus metrics in Azure Monitor managed service for Prometheus](../containers/prometheus-metrics-scrape-configuration). For example, consider the following:- **Tune Scrape Intervals**.<br>The default scrape frequency is 30 seconds, which can be changed per default target using the configmap. To balance the trade-off between data granularity and resource usage, adjust the `scrape_interval` and `scrape_timeout` based on the criticality of metrics.- **Drop unnecessary labels for high cardinality metrics**.<br>For high cardinality metrics, identify labels that aren't necessary and drop them to reduce the number of time series. Use the `metric_relabel_configs` to drop specific labels from ingestion. For more information, see [Prometheus Configuration](https://prometheus.

<a id="evidence-51"></a>

### 51. Best practices for migrating self-hosted Prometheus on Amazon EKS to Amazon Managed Service for Prometheus | Amazon Web Services

https://aws.amazon.com/blogs/opensource/best-practices-for-migrating-self-hosted-prometheus-on-amazon-eks-to-amazon-managed-service-for-prometheus · retrieved 2026-11-22 · text offsets 4926–5791

> A typical deployment of Grafana Agent for Prometheus metrics can provide up to 40 percent reduction in memory usage as compared to other agents. However, Grafana Agent comes with tradeoffs and removes some capabilities, such as support for recording or alerting rules. Read [“Configuring Grafana Cloud Agent for Amazon Managed Service for Prometheus”](/blogs/opensource/configuring-grafana-cloud-agent-for-amazon-managed-service-for-prometheus/) for a detailed description on setting up Grafana Cloud Agent.
> 
> ## Best practices
> 
> ### Security
> 
> Security is a top priority at AWS, and the [security pillar](https://wa.aws.amazon.com/wellarchitected/2020-07-02T19-33-23/wat.pillar.security.en.html) of the AWS Well-Architected Framework ensures protection of your applications’ information and systems. The security pillar focuses on protecting information and systems.

<a id="evidence-52"></a>

### 52. Best practices for migrating self-hosted Prometheus on Amazon EKS to Amazon Managed Service for Prometheus | Amazon Web Services

https://aws.amazon.com/blogs/opensource/best-practices-for-migrating-self-hosted-prometheus-on-amazon-eks-to-amazon-managed-service-for-prometheus · retrieved 2026-11-22 · text offsets 4046–4926

> You can deploy Prometheus server using Helm charts on Amazon EKS, and this is the preferred method for collecting and scraping application metrics and Amazon EKS worker node metrics to an AMP workspace. Another option is to use ADOT, which requires you to set up and configure two OpenTelemetry components: Prometheus receiver and the AWS Prometheus remote write exporter. For a detailed description on how to set up metrics ingestion with ADOT, refer the [user guide](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-onboard-ingest-metrics-OpenTelemetry.html).
> 
> [Grafana Agent](https://grafana.com/docs/tempo/latest/grafana-agent/) is a lightweight alternative to running full-scale Prometheus server on Amazon EKS. This agent enables easier sharding mechanisms that let users shard agent across the entire Amazon EKS cluster and lower memory requirements per machine.

<a id="evidence-53"></a>

### 53. Configuration | Prometheus

https://prometheus.io/docs/prometheus/latest/configuration/configuration/ · retrieved 2026-11-22 · text offsets 202692–203520

> `write_relabel_configs` is relabeling applied to samples before sending them to the remote endpoint. Write relabeling is applied after external labels. This could be used to limit which samples are sent.
> 
> There is a [small demo](https://github.com/prometheus/prometheus/blob/release-3.16/documentation/examples/remote_storage)  of how to use this functionality.
> 
> ```
> # The URL of the endpoint to send samples to.
> url: <string>
> 
> # protobuf message to use when writing to the remote write endpoint.
> #
> # * The `prometheus.WriteRequest` represents the message introduced in Remote Write 1.0, which
> # will be deprecated eventually.
> # * The `io.prometheus.write.v2.Request` was introduced in Remote Write 2.0 and replaces the former,
> # by improving efficiency and sending metadata, start timestamp and native histograms by default.
> #

<a id="evidence-54"></a>

### 54. How to manage high cardinality metrics in Prometheus and Kubernetes

https://grafana.com/blog/2022/10/21/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes · retrieved 2026-11-22 · text offsets 5575–6467

> _Note: The advantage of using a cloud native observability platform, like_ _[Grafana Cloud](/products/cloud/?pg=blog&plcmt=body-txt)__, which is powered by the most scalable time series database_ _[Grafana Mimir](/blog/2022/04/08/how-we-scaled-our-new-prometheus-tsdb-grafana-mimir-to-1-billion-active-series/?pg=blog&plcmt=body-txt)__, is that you won’t experience these performance issues as your count of time series increases._
> 
> ## [](#so-how-can-i-control-metrics-growth)So how can I control metrics growth?
> 
> Since the growth of metrics is inevitable and has consequences to your bottom line, it begs the question on how to control and optimize growing metrics and cost. As is the case with monitoring and observability, the answers to questions begin with having the right visibility and insights into the data.
> 
> Below are three key steps to controlling metrics cardinality and costs:

<a id="evidence-55"></a>

### 55. cloudflare/pint - docs/index.md

https://github.com/cloudflare/pint/blob/main/docs/index.md · retrieved 2026-11-22 · text offsets 1716–2608

> The only reason we would add support for other systems is if
> we started to use them ourselves.
> 
> ## Usage
> 
> There are three modes it works in:
> 
> - CI PR linting
> - Ad-hoc linting of selected files or directories
> - A daemon that continuously checks selected files or directories and exposes metrics describing
>   all discovered problems.
> 
> ### Pull Requests
> 
> Run it with `pint ci`. Git is currently the only supported VCS.
> 
> When `pint ci` runs it will find all files in the current working directory and try to parse
> them as Prometheus rules. Then it will look for all commits on the current branch that are not
> present in the parent branch and decide which rules were modified.
> Checks are run only on modified rules but they require the full list of all rules to find any
> cross-rule dependencies.
> 
> Running `pint ci` doesn't require any configuration but it's recommended to add a pint config file

<a id="evidence-56"></a>

### 56. cloudflare/pint - docs/index.md

https://github.com/cloudflare/pint/blob/main/docs/index.md · retrieved 2026-11-22 · text offsets 4376–5227

> Check specified files and report any found issue.
> You can pass directory paths and use [glob](https://pkg.go.dev/path/filepath#Match)
> patterns as arguments to select files for checking.
> 
> You can lint selected files:
> 
> ```shell
> pint lint rules.yml
> ```
> 
> or directories:
> 
> ```shell
> pint lint path/to/dir
> ```
> 
> or both:
> 
> ```shell
> pint lint path/to/dir file.yml path/file.yml path/dir
> ```
> 
> Using glob patterns:
> 
> ```shell
> pint lint path/*.yml path/*.yaml
> ```
> 
> ### Watch mode
> 
> Run pint as a daemon in watch mode where it continuously checks
> all rules found in selected files and exposes metrics about
> found problems.
> 
> By default it will start a HTTP server on port `8080` and run all checks every
> 10 minutes. This can be customised by passing extra flags to the `watch` command.
> Run `pint watch -h` to see all available flags.
> 
> Currently supported HTTP paths:

<a id="evidence-57"></a>

### 57. cloudflare/pint - docs/index.md

https://github.com/cloudflare/pint/blob/main/docs/index.md · retrieved 2026-11-22 · text offsets 0–12385

Literal matches in the stored extraction: "cardinality" (0), "series" (2), "cost" (0), "metric" (15), "churn" (0).

<a id="evidence-58"></a>

### 58. Configure your workspace

https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-workspace-configuration.html · retrieved 2026-11-22 · text offsets 3448–4196

> To add or modify label sets and their active series limits, choose **Edit** in the **Label sets** section. Then do the following:
> 
>    1. (Optional) Enter a value in **Default bucket limit** to set a limit on the maximum number of active time series that can be ingested in the workspace, counting only time series that don’t match any defined label set.
> 
>    1. To define a label set, enter an active time series limit for the new label set under **Active series limit**.
> 
>       Then, enter a label and value for one label that will be used in the label set, and choose **Add label**. 
> 
>    1. (Optional) To define another label set, choose **Add another label set** and repeat the previous steps.
> 
> 1. When you are finished, choose **Save changes**.

<a id="evidence-59"></a>

### 59. Best practices for migrating self-hosted Prometheus on Amazon EKS to Amazon Managed Service for Prometheus | Amazon Web Services

https://aws.amazon.com/blogs/opensource/best-practices-for-migrating-self-hosted-prometheus-on-amazon-eks-to-amazon-managed-service-for-prometheus · retrieved 2026-11-22 · text offsets 24312–25193

> Additionally, you can query logs from Prometheus collectors to determine whether you reach service quota limits. These service quotas can be increased by opening a support ticket, unless there is a hard limit listed in the quota page for AMP. Refer to the [user guide](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html) for more service quota information for AMP. Read the [documentation for creating alerts](https://docs.aws.amazon.com/grafana/latest/userguide/create-alerts.html) to set up alerts in Grafana.
> 
> **Type of data**
> 
> **Query to use**
> 
> **Default AMP quota limit**
> 
> Current active series
> 
> `prometheus_tsdb_head_series`
> 
> 1,000,000
> 
> Current ingestion rate
> 
> `rate(prometheus_tsdb_head_samples_appended_total[5m])`
> 
> 70,000 samples/second
> 
> Most-to-least list of active series per metric name
> 
> `sort_desc(count by(__name__) ({__name__!=""}))`
> 
> 200,000

<a id="evidence-60"></a>

### 60. pricing

https://www.aws.eu/prometheus/pricing · retrieved 2026-11-22 · text offsets 823–1706

> Charges for metrics ingested and stored are prorated by the hour and billed only when you send metrics. There is no Data Transfer IN charge for AMP.
> 
> Amazon Managed Service for Prometheus meters the Query Samples Processed (QSP) from all QueryMetric API requests. QSP is the total number of data points queried using PromQL for a given time range.
> 
> For the Amazon Managed Service for Prometheus collector, you are charged for the number of hours it is turned on and the number of samples collected.
> 
> The usage of Amazon Virtual Private Cloud (VPC) or VPC peering with Amazon Managed Service for Prometheus collector will incur additional charges as explained on the [Amazon Elastic Compute Cloud (EC2) on-demand pricing page.](/ec2/pricing/on-demand/) 
> 
> Except as otherwise noted, our prices are exclusive of applicable taxes and duties, including VAT, GST and applicable sales tax.

<a id="evidence-61"></a>

### 61. Best practices for migrating self-hosted Prometheus on Amazon EKS to Amazon Managed Service for Prometheus | Amazon Web Services

https://aws.amazon.com/blogs/opensource/best-practices-for-migrating-self-hosted-prometheus-on-amazon-eks-to-amazon-managed-service-for-prometheus · retrieved 2026-11-22 · text offsets 16652–17544

> The [performance efficiency pillar](https://wa.aws.amazon.com/wellarchitected/2020-07-02T19-33-23/wat.pillar.performance.en.html) helps organizations use IT and computing resources efficiently. This pillar specifically helps you build architectures on AWS that efficiently deliver sustained performance over time. With AMP, you can use the same open source Prometheus data model and query language that you use today to monitor the performance of your containerized workloads and also enjoy improved scalability, availability, and security without having to manage the underlying infrastructure. AMP automatically scales the ingestion, storage, and querying of operational metrics as workloads scale up and down.
> 
> #### High cardinality
> 
> Both Prometheus and AMP are designed to deal with high-cardinality metrics. Every unique combination of key-value label pairs represents a new time series.

<a id="evidence-62"></a>

### 62. Best practices for scaling Azure Monitor Workspaces with Azure Monitor managed service for Prometheus - Azure Monitor | Microsoft Learn

https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/azure-monitor-workspace-scaling-best-practice · retrieved 2026-11-22 · text offsets 7579–8412

> Consider creating additional DCRs and DCEs to distribute the ingestion load across multiple endpoints. This approach helps optimize performance and ensures efficient data handling. For more information about creating DCRs and DCEs, see [How to create custom Data collection endpoint(DCE) and custom Data collection rule(DCR) for an existing Azure monitor workspace to ingest Prometheus metrics](https://github.com/Azure/prometheus-collector/tree/main/Azure-ARM-templates/Prometheus-RemoteWrite-DCR-artifacts). |
> 
> ## Optimizing performance for high volumes of data
> 
> ### Ingestion
> 
> To optimize ingestion, consider the following best practices:
> 
> | Best practice | Description |
> | --- | --- |
> | Identify High cardinality Metrics. | Identify metrics that have a high cardinality, or metrics that are generating many time series.

<a id="evidence-63"></a>

### 63. Overview of Azure Monitor with Prometheus - Azure Monitor

https://docs.azure.cn/en-us/azure-monitor/metrics/prometheus-metrics-overview · retrieved 2026-11-22 · text offsets 1742–2600

> ## Benefits of Azure Monitor managed service for Prometheus
> 
> Key benefits of Azure Monitor managed service for Prometheus include:
> 
> *   Fully managed service hosted in Azure:
>     *   Automatic upgrades and scaling.
>     *   Data retention for 18 months with no cost for storage.
>     *   [Simple pricing based on ingestion and query](https://www.azure.cn/pricing/details/monitor/).
> *   Monitoring and observability:
>     *   [End-to-end, at-scale monitoring](../containers/kubernetes-monitoring-overview).
>     *   Out-of-the-box dashboards, alerts, and scrape configurations.
>     *   Native integration with key Azure Kubernetes Service (AKS) components, including [Customer Control Plane](/en-us/azure-resource-manager/management/control-plane-and-data-plane).
>     *   [Compliance with Azure Trust Center](azure-monitor-workspace-overview#data-considerations).

<a id="evidence-64"></a>

### 64. Query-side problems

https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/troubleshooting · retrieved 2026-11-22 · text offsets 47400–48400

> abel keys
> over the whole lifetime of your metric. The Cloud Monitoring imposes a limit
> on number of labels for each metric; for more information see the limits for
> [user-defined metrics](https://docs.cloud.google.com/monitoring/quotas.md.txt#custom_metrics_quotas).
> 
> > [!NOTE]
> > **Note:** The number of labels (also called *label names* , *label keys* , or *dimensions* ) is different than cardinality. [Cardinality](https://docs.cloud.google.com/monitoring/api/v3/metric-model.md.txt#cardinality) refers to the number of combinations of unique label values across all labels.
> 
> There are three steps to resolve this problem:
> 
> 1. Identify why a given metric has too many or frequently changing labels.
> 
>    - You can use the APIs Explorer widget on the [`metricDescriptors.list`](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.metricDescriptors/list.md.txt) page to call the method. For more information, see APIs Explorer. For examples, see [List metric and resource types](https

<a id="evidence-65"></a>

### 65. Query-side problems

https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/troubleshooting · retrieved 2026-11-22 · text offsets 2619–3515

> - Ingestion volumes for both byte- and sample-based billing, across metric domains and for individual metrics.
> - Data about labels and cardinality of metrics.
> - Number of reads for each metric.
> - Use of metrics in alerting policies and custom dashboards.
> - Rate of metric-write errors.
> 
> You can also use the **Metrics Management** page to
> [exclude unneeded metrics](https://docs.cloud.google.com/monitoring/docs/metrics-management.md.txt#exclude-metrics),
> eliminating the cost of ingesting them.
> 
> 
> To view the **Metrics Management** page, do the following:
> 
> 1. In the Google Cloud console, go to the
>    **Metrics management** page:
> 
>    [Go to **Metrics management**](https://console.cloud.google.com/monitoring/metrics-management)
> 
>    <br />
> 
>    If you use the search bar to find this page, then select the result whose subheading is
>    **Monitoring**.
> 2. In the toolbar, select your time window.

<a id="evidence-66"></a>

### 66. Query-side problems

https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/troubleshooting · retrieved 2026-11-22 · text offsets 17300–18300

> ormation associated with the original metric name.
> - The exporter not emitting a TYPE for each metric.
> - A transient issue where TYPE is dropped when the collector first starts up.
> 
> To resolve this issue, do the following:
> 
> - Stop using federation with Managed Service for Prometheus. If you want to reduce cardinality and cost by "rolling up" data before sending it to Monarch, see [Configure local aggregation](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/cost-controls.md.txt#local-aggregation).
> - Stop using Prometheus Remote Write in your collection path.
> - Confirm that the `# TYPE` field exists for each metric by visiting the `/metrics` endpoint.
> - Delete any relabeling rules that modify the name of a metric.
> - Delete any conflicting metrics with the "unknown" or "unknown:counter" suffix by [calling DeleteMetricDescriptor](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.metricDescriptors/delete.md.txt).
> - Or always query counters using a `rate`

<a id="evidence-67"></a>

### 67. Query-side problems

https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/troubleshooting · retrieved 2026-11-22 · text offsets 10513–11410

> prevents retrieval of values not related to the dashboard's contents.
> This query calls a supported endpoint for Prometheus.
> 
> For more information about supported endpoints, see [API
> compatibility](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/query-api-ui#http-api-details).
> 
> ### Quota exceeded
> 
> If you see the following error, then you have exceeded your read quota for
> the Cloud Monitoring API:
> 
> - "429: RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Time series queries ' and limit 'Time series queries per minute' of service 'monitoring.googleapis.com' for consumer 'project_number:...'."
> 
> To resolve this issue, submit a request to increase your read quota
> for the Monitoring API. For assistance, contact
> [Google Cloud Support](https://docs.cloud.google.com/support). For more information about
> quotas, see the [Cloud Quotas documentation](https://docs.cloud.google.

<a id="evidence-68"></a>

### 68. Query-side problems

https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/troubleshooting · retrieved 2026-11-22 · text offsets 36281–37155

> To resolve this issue, submit a request to increase your ingestion quota
> for the Monitoring API. For assistance, contact
> [Google Cloud Support](https://docs.cloud.google.com/support). For more information about
> quotas, see the [Cloud Quotas documentation](https://docs.cloud.google.com/docs/quotas/overview.md.txt).
> 
> ### Missing permission on the node's default service account
> 
> If you see one of the following errors, then the default service account on the
> node might be missing permissions:
> 
> - "execute query: Error querying Prometheus: client_error: client error: 403"
> - "Readiness probe failed: HTTP probe failed with statuscode: 503"
> - "Error querying Prometheus instance"
> 
> Managed collection and the managed rule evaluator in
> Managed Service for Prometheus both use the default service account
> on the node. This account is created with all the necessary permissions,

<a id="evidence-69"></a>

### 69. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 3439–4319

> | `429 Too Many Samples` / `out of bounds` errors | Hitting Mimir/Cortex ingester per-tenant series limit | [Per-metric drill-down](#step-3-per-metric-drill-down), find the new offender |
> | Grafana Cloud Active Series bill spiked | New metric, new label, or rollout creating churn | [Per-metric drill-down](#step-3-per-metric-drill-down) + churn check |
> | Grafana Cloud DPM bill spiked but Active Series flat | Scrape interval shortened, OR remote_write sending duplicates | DPM-side issue — route to `dpm-finder` |
> | `series_limit_per_user` errors after a deploy | Application change introduced a new bad label | [Recent change diff](#step-4-recent-change-diff) |
> | Series count grows then resets every restart | Series churn from ephemeral label values | [Churn diagnosis](#step-5-churn-diagnosis) |
> 
> ---
> 
> ## Step 1: Active Series Triage
> 
> ### Get the headline number
> 
> ```promql

<a id="evidence-70"></a>

### 70. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 0–890

> Repository cloned to: /tmp/pi-github-repos/runtime-XoxDvQ/fc13cb6a24214cd02c558419d2658e186f70c974649b42cf013fde7200bafcc5
> 
> ## skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md
> ---
> name: prometheus-cardinality-troubleshooter
> license: Apache-2.0
> description: >
>   Diagnostic guide for active Prometheus cardinality problems — slow queries, OOMing
>   Prometheus, high Grafana Cloud Active Series or DPM bills, "too many samples" ingest
>   errors, series churn, or rapid memory growth. Walks through tsdb status endpoints,
>   per-metric and per-label drill-downs, common-culprit galleries, and remediation paths.
>   Use when the user is *currently experiencing* a cardinality fire. For preventing
>   cardinality issues at the source, route to prometheus-label-strategy. For post-ingest
>   aggregation, route to adaptive-metrics. For DPM-specific analysis, route to dpm-finder.
> ---

<a id="evidence-71"></a>

### 71. How to manage high cardinality metrics in Prometheus and Kubernetes

https://grafana.com/blog/2022/10/21/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes · retrieved 2026-11-22 · text offsets 7358–8224

> [Chart showcasing how to optimize cardinality for value.](/mw/_next/image/?url=https%3A%2F%2Fs3.amazonaws.com%2Fa-us.storyblok.com%2Ff%2F1022730%2Fd6f306974e%2Fgrafana-cardinality-metrics-quadrants.png&w=3840&q=75)
> 
> #### [](#identifying-high-cardinality-metrics-and-labels)Identifying high cardinality metrics and labels
> 
> Grafana Cloud Pro and Advanced plans include a set of [cardinality management dashboards](/docs/grafana-cloud/billing-and-usage/control-prometheus-metrics-usage/cardinality-management/?pg=blog&plcmt=body-txt) to help identify high cardinality metrics and labels and guide your optimization efforts.
> 
> ![Grafana dashboard for cardinality management in Grafana Cloud Pro and Advanced.](/mw/_next/image/?url=https%3A%2F%2Fs3.amazonaws.com%2Fa-us.storyblok.com%2Ff%2F1022730%2F60c50dbdba%2Fgrafana-dashboard-cardinality-management.png&w=3840&q=75)

<a id="evidence-72"></a>

### 72. grafana/skills - skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md

https://github.com/grafana/skills/blob/main/skills/grafana-cloud/prometheus-cardinality-troubleshooter/SKILL.md · retrieved 2026-11-22 · text offsets 0–18497

Literal matches in the stored extraction: "adaptive" (15), "Active Series" (10), "series_limit" (1), "recording rule" (1).
