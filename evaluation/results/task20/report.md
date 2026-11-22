# Streamable HTTP 的工程实现方案

## 结论先行（置信度：规范与 SDK 机制 高；"Anthropic 发布"这一前提 低）

Streamable HTTP 的"最新实现"在 2026 年已经分裂为**两代形态**，工程上必须先分清自己要对齐哪一代，否则代码会互相打架：

- **第一代（2025-03-26 引入，2025-11-25 是最后修订）**：单端点同时支持 POST 与 GET，有 `Mcp-Session-Id` 会话、独立 GET SSE 流、`Last-Event-ID` 断线恢复、DELETE 终止会话 [1](#evidence-1)[2](#evidence-2)。
- **第二代（2026-07-28 现行修订）**：单端点**只接受 POST**，**删除协议级会话**、**删除 GET 流**、**SSE 不可恢复**；每个请求自带协议版本与镜像头，SSE 流按请求作用域建立，关闭 SSE 流本身即取消语义 [3](#evidence-3)[4](#evidence-4)[5](#evidence-5)[6](#evidence-6)。

参考实现的工程骨架（TypeScript SDK 的 `WebStandardStreamableHTTPServerTransport` / `NodeStreamableHTTPServerTransport`）可以概括为：**一个 transport 对象持有 `sessionId` + 三张映射表（stream / request→stream / request→response）；`sessionIdGenerator` 的有无在同一个类里切换有状态与无状态；POST 按消息类型分派到 202 / 单 JSON / 请求作用域 SSE 三条路径；事件先落 `EventStore` 再写流；DELETE 触发 `onsessionclosed` 后 `close()`** [7](#evidence-7)[8](#evidence-8)[9](#evidence-9)[10](#evidence-10)[11](#evidence-11)。

必须先纠正一个前提：证据库里**没有任何 Anthropic 产品或公告**把 Streamable HTTP 作为 Anthropic 的发布物；它是 MCP 规范定义、由 `modelcontextprotocol` 组织下的参考 SDK 实现的传输层，Anthropic 只以"MCP 客户端宿主（如 Claude Code）"的身份出现 [12](#evidence-12)[13](#evidence-13)。所以"Anthropic 最新发布"这一说法在现有证据下**无法证实**，下面的内容按"MCP Streamable HTTP 最新规范的工程实现"来答。

---

## 一、两代规范形态对比

| 维度 | 2025-03-26 → 2025-11-25 | 2026-07-28（现行） |
|---|---|---|
| 端点方法 | POST + GET 同一路径 [1](#evidence-1) | 仅 POST [4](#evidence-4) |
| 会话 | `Mcp-Session-Id`，DELETE 终止 [2](#evidence-2) | 无协议级会话 [3](#evidence-3) |
| 服务端主动消息 | 独立 GET SSE 流 [14](#evidence-14) | 只走 `subscriptions/listen` 的响应流 [4](#evidence-4)[6](#evidence-6) |
| 服务端请求（sampling/elicitation） | 可在 SSE 上发 JSON-RPC request [4](#evidence-4) | 改为 `InputRequiredResult` 内嵌 input requests（MRTR）[4](#evidence-4)[15](#evidence-15) |
| 断线恢复 | `Last-Event-ID` 按流重放 [16](#evidence-16) | 不支持，`Last-Event-ID` 直接忽略 [5](#evidence-5)[17](#evidence-17) |
| 取消 | 另有机制 | 关闭 SSE 响应流即取消 [6](#evidence-6) |

现行版把"传输"压到极简：客户端每条 JSON-RPC 请求/通知各发一个 POST；服务端对请求二选一回单 JSON 或**仅属于该请求**的 SSE 流（请求相关的进度/日志通知 + 最终响应），对通知回 `202 Accepted` [4](#evidence-4)。这个"SSE 流作用域 = 请求"的设计直接换来一个好处：传输层断开是无歧义的取消信号，服务端应尽快停止工作且不得再为该请求发消息 [6](#evidence-6)。

---

## 二、服务端实现细节（以 TS 参考实现为标本）

### 1. 有状态 / 无状态由构造函数的一个字段决定

`sessionIdGenerator` 未提供即"会话管理被禁用（无状态模式）"；提供则该 transport 是有状态的 [18](#evidence-18)[8](#evidence-8)。两种模式的对外行为在类注释里写死得很清楚：

- 有状态：生成会话 ID 并写进响应头、初始化响应必带 ID、无效 ID → `404`、非初始化请求缺 ID → `400`、状态（连接、消息历史）存内存 [8](#evidence-8)。
- 无状态：任何响应都不带会话 ID、不做会话校验 [8](#evidence-8)。

同一段语义在 Kotlin SDK 中一致（有状态 `404`/`400`，无状态不校验），说明这是跨语言 SDK 的共同约定而非 TypeScript 的偶然选择 [19](#evidence-19)。

### 2. 一个 transport 实例 = 一个会话；无状态时 = 一个请求

`handleRequest` 进门先做三件事：已关闭 → `404 Session not found`；**无状态 transport 第二次被调用直接抛错**（"Stateless transport cannot be reused across requests. Create a new transport per request."）；做 DNS rebinding 头校验；然后按 `POST` / `GET` / `DELETE` 分派 [20](#evidence-20)。

这条约束是很多实现踩坑的根源：有状态部署下可以每个 HTTP 请求新建 transport 但把 session 留在共享存储里保持"会话活着"（SDK 注释明确提示多节点场景可以这样拆开）[18](#evidence-18)[8](#evidence-8)；无状态部署下 transport 生命周期就绑死单次请求。

### 3. 内部状态：三张映射表 + 两个开关

实例字段包括 `_streamMapping`（streamId → controller/encoder/cleanup）、`_requestToStreamMapping`（requestId → streamId）、`_requestResponseMap`（requestId → 已产出的响应）、`_initialized`、`_standaloneSseStreamId = '_GET_stream'`、`_eventStore` [7](#evidence-7)。这就是全部"会话状态"，也是为什么它能被外部化：只要把这三张表和三段流的生命周期搬进共享存储，就能跨实例续接。

### 4. 初始化门禁

POST 解析出消息后：若是 `initialize`，且已初始化且已有 sessionId → `400 Server already initialized`；批量里超过一条 initialize → `400 Only one initialization request is allowed`；否则 `this.sessionId = this.sessionIdGenerator?.()` 并置 `_initialized = true`，再回调 `onsessioninitialized` [9](#evidence-9)。非初始化请求则先 `validateSession` 再 `validateProtocolVersion` [9](#evidence-9)。

`validateSession` 的三段返回是规范条文的直译：未初始化 → `400`；无 `Mcp-Session-Id` → `400`（"header is required"）；ID 不匹配 → `404 Session not found` [11](#evidence-11)。这与规范"服务端可随时终止会话，此后必须对带该 ID 的请求回 404，客户端必须新建会话重新初始化"一一对应 [2](#evidence-2)。

### 5. POST 的三条响应路径

1. **只含通知/响应** → 逐条投递给 `onmessage`，返回 `202 Accepted` 空体 [9](#evidence-9)。
2. **`enableJsonResponse = true`** → 建一个 `resolveJson` sink 挂进 `_streamMapping`，返回一个"等所有响应就绪后 resolve"的 Promise [21](#evidence-21)。该选项默认 `false`，即**默认优先 SSE** [8](#evidence-8)。
3. **默认 SSE** → 生成 `streamId`，建 `ReadableStream`，响应头固定为 `Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`，有 sessionId 时附上 `mcp-session-id`；登记映射后写 priming event，再逐条投递 [21](#evidence-21)。

`X-Accel-Buffering: no` 不是可选项而是工程必需：规范明确要求它来让 nginx 之类的反代关闭响应缓冲，否则 SSE 事件会被攒在缓冲区里，破坏实时性 [4](#evidence-4)[22](#evidence-22)。

### 6. 事件存储与可恢复：store-first + 重放去重

`EventStore` 接口就一个核心方法 `storeEvent(streamId, message) → eventId` [23](#evidence-23)。写入顺序被刻意设计成"**先 store 再 write**"：即使此刻没有活跃的 SSE writer，只要请求仍在飞行中，事件也已落库，`Last-Event-ID` 重连时能补发；`send()` 在 `await storeEvent()` 之后**重新读一次** `_streamMapping`，因为重连可能在这期间注册了新的流；随后用 `replayedEventIds` 做身份去重，避免重放路径刚刚写过的事件被写第二遍 [10](#evidence-10)。

priming event（空 data、带 event id 与 retry 提示）只在配置了 `eventStore` **且**客户端协议版本 ≥ 2025-11-25（能处理空 SSE data）时才发；老客户端发了会解析失败 [24](#evidence-24)。priming event 里的 `retry` 字段配合 `closeSSEStream()` / `closeStandaloneSSEStream()` 就构成"长任务轮询"模式：服务端主动关流让客户端按 retry 间隔重连 [25](#evidence-25)[11](#evidence-11)。C# SDK 把同一思路产品化为 `EventStreamStore` + `EnablePollingAsync()`：POST 响应提前结束、handler 在后台继续跑，从而释放客户端的 HTTP/2 流槽位 [26](#evidence-26)。

### 7. GET 独立流与 DELETE

GET 分支：`Accept` 不含 `text/event-stream` → `406`；`validateSession`；`validateProtocolVersion`；有 `Last-Event-ID` 且配置了 EventStore → 走 `replayEvents`；**同一会话只允许一条 standalone 流**，已存在则 `409 Conflict` [27](#evidence-27)。重放路径还要先查 `getStreamIdForEventId` 判断流冲突，冲突同样 `409` [27](#evidence-27)[28](#evidence-28)。

DELETE 分支最简：校验会话与版本 → `await onsessionclosed(sessionId)` → `200` → `finally { await close() }`，`close()` 把 `_streamMapping` 全部 cleanup 并清空 `_requestResponseMap` [11](#evidence-11)。注意 `onsessionclosed` 与 transport 关闭是两个不同事件，SDK 注释专门提醒多节点场景下"每个请求后关 transport 但会话继续活着"是合法形态 [18](#evidence-18)。

### 8. 输入侧防御

POST 的 `Accept` 必须同时包含 `application/json` 与 `text/event-stream`，否则 `406`（注释说明 Accept 是逗号分隔列表，用子串判断是**有意**的语义，而 Content-Type 必须走解析后的 media type）[29](#evidence-29)。请求体有大小上限（默认 4 MiB），超限在读之前就 `413` [8](#evidence-8)。批量消息超过 `MAX_BATCH_SIZE` → `400`；schema 解析失败 → `400 Parse error` [9](#evidence-9)。

---

## 三、客户端实现细节

### 1. 公共头由一处统一生成

`_commonHeaders()` 做三件事：从 auth provider 取 token 写 `Authorization: Bearer`；有会话写 `mcp-session-id`；有协议版本写 `mcp-protocol-version` [30](#evidence-30)。这解释了为什么 `mcp-protocol-version` 必须在断线重连时被显式记住：重连时要用"原握手协商出的那个版本"，因此 SDK 把它做成构造参数而不是从响应里猜 [31](#evidence-31)。

### 2. POST 的完整分支

请求头写死 `content-type: application/json` 与 `accept: application/json, text/event-stream`；从响应头读取并保存 `mcp-session-id`（这就是会话建立的时刻）[32](#evidence-32)。之后：

- `401` + 有 authProvider → 取 `WWW-Authenticate` 的 `resource_metadata`/`scope` 跑授权流程后重发；带 `_hasCompletedAuthFlow` 防无限递归 [32](#evidence-32)。
- `403` + `insufficient_scope` → 做 step-up 提权重试，用 `_lastUpscopingHeader` 防重复升级死循环 [32](#evidence-32)。
- `202` → 丢弃空体；**如果被接受的是 `notifications/initialized`，此时才去开 GET SSE 流** [32](#evidence-32)。
- 有请求 id 时按 `content-type` 解析出的 media type 分流：`text/event-stream` 走 SSE handler，`application/json` 直接解析 [32](#evidence-32)。

### 3. GET 流与重连

GET 只带 `Accept: text/event-stream`，可选带 `last-event-id`；`401` 先走授权再重开 [30](#evidence-30)。重连参数默认值是工程上值得记住的一组：初始 1000ms、上限 30000ms、增长因子 1.5、最多 2 次 [33](#evidence-33)。单请求级别还有一个重要区分：调用方通过 `requestSignal` 主动 abort 时，POST 及其 SSE 响应流被**有意**拆除，不触发 `onerror`、不重连 [34](#evidence-34)；而 `onRequestStreamEnd` 只在非主动的原因为（服务端关闭、网络断开、重连耗尽）时触发 [35](#evidence-35)。

### 4. 404 的处理是跨实现的一致性难题

规范要求：收到带 `Mcp-Session-Id` 的请求返回 `404`，客户端**必须**用不带会话 ID 的新 `InitializeRequest` 重建会话 [2](#evidence-2)[36](#evidence-36)。Rust SDK 的 #1476 就是这条没实现干净的后果：SSE resume GET 拿到 `404` 后被归类为"可重试"，指数退避没有上限，重连循环永不结束，飞行中的长任务永久挂起 [37](#evidence-37)[38](#evidence-38)。报告里区分得很准确——POST 的 `404` 可以重试（服务端没执行），但 resume GET 的 `404` 意味着原请求已经执行过、响应流已丢失，只能以会话过期错误失败 [36](#evidence-36)。**这就是自研客户端最该抄的一条规则：区分"请求未执行"和"流已丢失"。**

---

## 四、部署拓扑：默认无状态

工程建议非常一致：**默认无状态**。无状态 = 每个请求自包含，任意副本可服务任意请求，横向扩缩、负载均衡、无服务器部署都变成普通 Web 运维问题，且重启/崩溃不掉线；有状态 = 会话钉在某个进程上，必须做粘性路由或把会话状态外置到共享存储 [39](#evidence-39)[40](#evidence-40)。C# SDK 官方立场更激进：推荐大多数服务器把 `SessionMode` 设为 `Stateless`，以规避会话带来的复杂度、内存开销和部署约束 [41](#evidence-41)。

具体到 2026-07-28：带该版本 `MCP-Protocol-Version` 头的 POST 会被自动路由到无状态路径，不建会话、不回 `Mcp-Session-Id`、**GET 与 DELETE 端点根本不再映射** [42](#evidence-42)；有状态专属的旋钮（`IdleTimeout`、`MaxIdleSessionCount`、`EventStreamStore`、`SessionMigrationHandler`、`PerSessionExecutionContext`）全部被标 `[Obsolete]`（诊断号 `MCP9006`），只对 initialize 握手的老客户端有效 [43](#evidence-43)。反过来，在有状态服务器上收到 2026-07-28 请求会被 `-32022 UnsupportedProtocolVersion` 拒绝，促使双路径客户端降级到握手流程 [43](#evidence-43)。

选型判据也很清楚：纯函数型工具、不需要 elicitation/sampling、不需要主动推送通知、要无粘性地横向扩展或跑 Serverless 的，用无状态；绝大多数 MCP 服务器属于这一类 [44](#evidence-44)。无状态模式下每个 HTTP 请求会创建并销毁一个短命 `McpServer` 实例，日志层面会看到每请求一对 `session created/disposed` 的 Trace 记录 [45](#evidence-45)。

如果确实需要状态，运维上要准备两件事：**空闲超时**（过期会话 ID 收 `404 Session not found`，客户端应重建会话）与**空闲会话上限**（C# 默认 10,000，超限时记 critical 日志并从最老的开始强制回收，有活跃请求的会话不计入）[46](#evidence-46)。老 SSE 端点（`/sse`、`/message`）在 C# SDK 中默认关闭，原因写的是背压问题，且始终走有状态模式 [47](#evidence-47)。

---

## 五、安全：三条互不替代的控制线

规范把安全要求写成三条硬性/建议项：**必须**校验所有入站请求的 `Origin`（存在且非法 → `403 Forbidden`，响应体可选一个无 `id` 的 JSON-RPC error）、本地运行时**应**只绑 `127.0.0.1`、**应**对所有连接实现认证；否则攻击者可用 DNS rebinding 从远程网页操纵本地 MCP 服务器 [48](#evidence-48)[49](#evidence-49)。

这三条被明确拆成回答三个不同问题：绑定地址决定"哪些网卡收流量"，`Origin` 校验决定"哪个 Web 源可以调用"，认证授权决定"哪个主体、哪些 scope 可以执行"；任何一条都不能替代另一条 [50](#evidence-50)。落地时的常见错误也被点名：必须用**完整 origin 的精确白名单**（scheme + hostname + port），后缀匹配、通配、回显请求里的 Origin 都会直接击穿边界；`Host` 与 `Origin` 不可互换；对没有 `Origin` 的请求要显式决策（原生客户端常不带，浏览器一般会带），可以为原生客户端路径放行，但绝不能因此绕过认证 [51](#evidence-51)。反代终止 TLS 时，要确认 `Origin` 原样抵达应用，且校验发生在 JSON-RPC 解析和工具分发**之前** [51](#evidence-51)。容器端口映射和反代也可能把"内部绑定"变成 LAN 可达，所以应采用运行时实际监听地址而非框架默认值来审计 [51](#evidence-51)[52](#evidence-52)。

同时要认清 `Origin` 校验的边界：它只防浏览器中介的访问与 DNS rebinding，不防本机恶意进程直接请求，也不构成对 MCP 进程的文件系统/凭据沙箱 [52](#evidence-52)。

认证侧的三条硬规则：MCP 服务器**只能**接受签发给自己的 token（audience binding），并**不得**把客户端给的 token 透传给上游 API，必须换用独立凭据 [53](#evidence-53)[54](#evidence-54)。服务器角色自 2025-06-18 起是 OAuth resource server，只负责指向授权服务器，这使它可以被塞到既有 IdP 前面而不必自建登录 [12](#evidence-12)。会话与用户的绑定属于应用层责任：C# SDK 在创建会话时捕获 `HttpContext.User` 身份，身份不符的请求被拒，但官方也说明会话绑定不替代授权，仍需 `RequireAuthorization()` [55](#evidence-55)[56](#evidence-56)。最后一句最该转给产品同事：**传输层不白送任何安全**，一个未认证的远程 MCP 服务器就是一个"模型可调用的开放 API"，认证、输入校验、按 token 的最小权限是远程化的基线而非加固项 [57](#evidence-57)。

---

## 六、2026-07-28 独有的工程陷阱：镜像头 + 头体校验

这一代最容易被低估的复杂度来自"把 JSON-RPC body 里的字段镜像到 HTTP 头，给中间设备用"：

- 每个 POST **必须**带 `MCP-Protocol-Version`，且其值**必须**等于 body `_meta["io.modelcontextprotocol/protocolVersion"]`，不一致 → `400` + `HeaderMismatch` [15](#evidence-15)。
- `Mcp-Method`、`Mcp-Name` 是合规性必需头，`Mcp-Name` 取值来自 `params.name` 或 `params.uri` [15](#evidence-15)。
- 工具参数可通过 `x-mcp-header` 注解提升为 `Mcp-Param-{Name}` 头；值必须是安全 ASCII，否则用 `=?base64?...?=` 哨兵格式编码，且"看起来像哨兵的纯 ASCII 值"也必须再编码一次以消歧 [58](#evidence-58)[59](#evidence-59)。
- 服务端**必须**解码后与 body 比对，任何不匹配 → `400` + `-32020 HeaderMismatch`；不认识的 `Mcp-Param-*` 中间服务器必须转发而非丢弃 [59](#evidence-59)[60](#evidence-60)。

规范把动机写得很直白：防止网络中不同组件"各自信任不同事实源"——比如负载均衡按头路由、MCP 服务器按 body 执行 [60](#evidence-60)。因此对中间设备的建议是：**如果 `MCP-Protocol-Version` 表明这是个需要头体校验的版本，就信任头；否则应拒绝而不是信任未校验的头值** [60](#evidence-60)。客户端侧还有个配套行为：因缺/错 `Mcp-Param-*` 被拒时，应先调 `tools/list` 检查 schema 是否变化再重试 [59](#evidence-59)；而含非法 `x-mcp-header` 的工具定义会被客户端从 `tools/list` 结果中剔除并记警告 [61](#evidence-61)。

---

## 七、迁移与兼容：三件事别做错

1. **2024-11-05 的 HTTP+SSE 已废弃**（自 2025-03-26 起），新实现不应采用，存量应迁移；它用的是 `/sse` + `/messages` 双端点 [17](#evidence-17)[62](#evidence-62)。
2. **服务端兼容老客户端** = 在 `/mcp` 之外继续托管老的 SSE 与 POST 端点；把老 POST 端点与新 MCP 端点合并虽然可行，但会引入不必要的复杂度 [62](#evidence-62)。
3. **客户端探测要带脑子**。老规则是"POST 失败于 4xx 就去 GET 期待首个 `endpoint` 事件" [63](#evidence-63)[64](#evidence-64)；但现代服务端也用 `400` 表达 `UnsupportedProtocolVersionError`、缺少客户端能力、头校验失败，所以现行规则加了一层：**先看 body 是不是可识别的现代 JSON-RPC error，是就别降级**，空体或不可识别才回退到 `initialize` [60](#evidence-60)[64](#evidence-64)。协议层也留了同样的区分钩子：未知方法的 `404` 会带 `-32601` 的 JSON-RPC error，正是用来和"老 SSE 服务器不托管现代端点"的裸 `404` 区分 [65](#evidence-65)。

SDK 层还有更结构化的"代际探测"：PHP SDK 用 `server/discover` 探测，据 `DiscoverResult` 或 `-32022` 携带的 `supported` 列表决定留在现代代际还是回退握手 [66](#evidence-66)；C# 客户端对 HTTP 的做法是首发带 2026-07-28 版本头的请求，若 `400` 且不是结构化的 `-32022`/`-32021`/`-32020`，就切到同端点的 `initialize` 流程 [43](#evidence-43)。

另外注意：现行版服务器收到老形态流量时的标准应答是 GET/DELETE → `405`、带 `Mcp-Session-Id` → 忽略且不签发不回显、带 `Last-Event-ID` → 忽略 [67](#evidence-67)[17](#evidence-17)。C# 的实现与之吻合：2026-07-28 请求不映射 GET/DELETE [42](#evidence-42)。

---

## 八、可直接抄的工程清单

1. **先定代际再写代码**：目标若是"最新"，就是 POST-only + 无会话 + 无恢复，别再实现 GET 流和 Last-Event-ID [3](#evidence-3)[4](#evidence-4)。
2. **默认无状态**：无状态省掉粘性会话、会话存储、跨实例迁移；只有当确实需要 elicitation/sampling/主动推送时才上会话 [39](#evidence-39)[44](#evidence-44)。
3. **transport 生命周期显式化**：无状态下一请求一实例、禁止复用 [20](#evidence-20)；有状态下允许"请求级 transport + 会话级存储"分离 [8](#evidence-8)。
4. **事件先落库再写流**，且用 `(streamId, eventId)` 做身份去重 [10](#evidence-10)。
5. **SSE 响应头固定四件套**（`text/event-stream`、`no-cache, no-transform`、`keep-alive`、`X-Accel-Buffering: no`），长静默流周期性发 `:` 注释保活 [21](#evidence-21)[22](#evidence-22)。
6. **只允许一条独立 GET 流**，冲突回 `409` [27](#evidence-27)。
7. **`404` 语义分叉**：请求未执行可重试，流已丢失必须报会话过期并重建会话 [36](#evidence-36)[38](#evidence-38)。
8. **`Accept` 严格双类型校验 → `406`**，Content-Type 走解析而非子串 [29](#evidence-29)。
9. **Origin 精确白名单 + 403 + 前置校验**（在 JSON-RPC 解析之前），并单独审计实际监听地址 [51](#evidence-51)[48](#evidence-48)。
10. **token 只认自己为 audience，绝不透传** [53](#evidence-53)。

---

## 九、证据局限（必须明说）

- **"Anthropic 发布"无法证实**：证据库中没有 Anthropic 相关产品公告、Claude Code / Agent SDK / Claude API 的 Streamable HTTP 文档；现有材料只把 Streamable HTTP 定位为 MCP 规范传输，并由 `modelcontextprotocol` 组织的参考 SDK 实现 [12](#evidence-12)[13](#evidence-13)。
- **非 TypeScript 实现只到"行为约定"层级**：Kotlin 的会话语义 [19](#evidence-19)、C# 的会话模式与运维参数 [42](#evidence-42)[46](#evidence-46)[26](#evidence-26)、PHP 的代际协商 [66](#evidence-66)[68](#evidence-68) 有实证，但**没有 Go / Java 实现内部结构、也没有 FastMCP 源码**；框架层只出现在一句提及中（FastMCP "处理了大部分 Streamable HTTP、会话与认证管道"）[69](#evidence-69)。
- **部分数字来自 SDK 的官方文档/源码注释而非规范条文**（如 10,000 空闲会话上限 [46](#evidence-46)、15,000ms keep-alive 默认值 [8](#evidence-8)、重连 4 个默认参数 [33](#evidence-33)），它们是实现默认值，不是协议要求。
- 少数条目来自第三方指南与博客（无状态/有状态对比 [39](#evidence-39)、Origin 落地建议 [51](#evidence-51)），其结论与规范条文一致，但严格程度应低于规范与源码。

## Evidence

<a id="evidence-1"></a>

### 1. stdio

https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-03-26/basic/transports.mdx · retrieved 2026-11-22 · text offsets 1773–2660

> This replaces the [HTTP+SSE
> transport](/specification/2024-11-05/basic/transports#http-with-sse) from
> protocol version 2024-11-05. See the [backwards compatibility](#backwards-compatibility)
> guide below.
> 
> </Info>
> 
> In the **Streamable HTTP** transport, the server operates as an independent process that
> can handle multiple client connections. This transport uses HTTP POST and GET requests.
> Server can optionally make use of
> [Server-Sent Events](https://en.wikipedia.org/wiki/Server-sent_events) (SSE) to stream
> multiple server messages. This permits basic MCP servers, as well as more feature-rich
> servers supporting streaming and server-to-client notifications and requests.
> 
> The server **MUST** provide a single HTTP endpoint path (hereafter referred to as the
> **MCP endpoint**) that supports both POST and GET methods. For example, this could be a
> URL like `https://example.com/mcp`.

<a id="evidence-2"></a>

### 2. stdio

https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-03-26/basic/transports.mdx · retrieved 2026-11-22 · text offsets 8681–11300

> act as a cursor within that particular stream.
> 
> ### Session Management
> 
> An MCP "session" consists of logically related interactions between a client and a
> server, beginning with the [initialization phase](/specification/2025-03-26/basic/lifecycle). To support
> servers which want to establish stateful sessions:
> 
> 1. A server using the Streamable HTTP transport **MAY** assign a session ID at
>    initialization time, by including it in an `Mcp-Session-Id` header on the HTTP
>    response containing the `InitializeResult`.
>    - The session ID **SHOULD** be globally unique and cryptographically secure (e.g., a
>      securely generated UUID, a JWT, or a cryptographic hash).
>    - The session ID **MUST** only contain visible ASCII characters (ranging from 0x21 to
>      0x7E).
> 2. If an `Mcp-Session-Id` is returned by the server during initialization, clients using
>    the Streamable HTTP transport **MUST** include it in the `Mcp-Session-Id` header on
>    all of their subsequent HTTP requests.
>    - Servers that require a session ID **SHOULD** respond to requests without an
>      `Mcp-Session-Id` header (other than initialization) with HTTP 400 Bad Request.
> 3. The server **MAY** terminate the session at any time, after which it **MUST** respond
>    to requests containing that session ID with HTTP 404 Not Found.
> 4. When a client receives HTTP 404 in response to a request containing an
>    `Mcp-Session-Id`, it **MUST** start a new session by sending a new `InitializeRequest`
>    without a session ID attached.
> 5. Clients that no longer need a particular session (e.g., because the user is leaving
>    the client application) **SHOULD** send an HTTP DELETE to the MCP endpoint with the
>    `Mcp-Session-Id` header, to explicitly terminate the session.
>    - The server **MAY** respond to this request with HTTP 405 Method Not Allowed,
>      indicating that the server does not allow clients to terminate sessions.
> 
> ### Sequence Diagram
> 
> ```mermaid
> sequenceDiagram
>     participant Client
>     participant Server
> 
>     note over Client, Server: initialization
> 
>     Client->>+Server: POST InitializeRequest
>     Server->>-Client: InitializeResponse<br>Mcp-Session-Id: 1868a90c...
> 
>     Client->>+Server: POST InitializedNotification<br>Mcp-Session-Id: 1868a90c...
>     Server->>-Client: 202 Accepted
> 
>     note over Client, Server: client requests
>     Client->>+Server: POST ... request ...<br>Mcp-Session-Id: 1868a90c...
> 
>     alt single HTTP response
>       Server->>Client: ... response ...
>     else server opens SSE stream
>       loop while connection remains open
>           Server-)Client: ... SSE messages from server ...
>       end

<a id="evidence-3"></a>

### 3. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 0–899

> ## docs/specification/2026-07-28/basic/transports/streamable-http.mdx
> ---
> title: Streamable HTTP
> ---
> 
> <div id="enable-section-numbers" />
> 
> <Info>
> 
> Streamable HTTP was introduced in protocol version 2025-03-26 as a replacement
> for the [HTTP+SSE transport][http-sse] from protocol version 2024-11-05.
> 
> </Info>
> 
> <Info>
> 
> Revision 2026-07-28 changed the behavior of Streamable HTTP. Clients must
> ensure they handle backwards compatibility correctly. Changes included:
> 
> - Removal of the GET stream endpoint.
> - Removal of protocol-level sessions.
> 
> See the [changelog](/specification/2026-07-28/changelog) and
> [Backward Compatibility](#backward-compatibility) below.
> 
> </Info>
> 
> In the **Streamable HTTP** transport, the server operates as an independent
> process that can handle multiple client connections. At a glance:
> 
> - The server exposes a single HTTP endpoint (the **MCP endpoint**) that
>   accepts POST.

<a id="evidence-4"></a>

### 4. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 899–6100

> - The client sends every JSON-RPC request or notification as its own HTTP
>   POST.
> - The server answers each request with either a single JSON object or a
>   [Server-Sent Events][sse] (SSE) stream scoped to that request, carrying
>   request-related notifications followed by the final response.
> - Server-to-client interactions (sampling, elicitation, roots) are embedded
>   in results as input requests per
>   [Multi Round-Trip Requests (MRTR)][mrtr] ([SEP-2322][sep-2322]).
> - Long-lived change notifications (such as list changes and resource updates)
>   are delivered on the response stream of a
>   [`subscriptions/listen`][subscriptions-listen] request.
> 
> See [Message Flow](#message-flow) for sequence diagrams of these
> interactions.
> 
> The server **MUST** provide a single HTTP endpoint path (hereafter referred to
> as the **MCP endpoint**) that supports POST. For example, this could be a URL
> like `https://example.com/mcp`.
> 
> [http-sse]: /specification/2024-11-05/basic/transports#http-with-sse
> [sse]: https://en.wikipedia.org/wiki/Server-sent_events
> 
> ## Security & Endpoint
> 
> When implementing Streamable HTTP transport:
> 
> 1. Servers **MUST** validate the `Origin` header on all incoming connections
>    to prevent DNS rebinding attacks.
>    - If the `Origin` header is present and invalid, servers **MUST** respond
>      with HTTP 403 Forbidden. The HTTP response body **MAY** comprise a
>      JSON-RPC _error response_ that has no `id`.
> 2. When running locally, servers **SHOULD** bind only to localhost
>    (127.0.0.1) rather than all network interfaces (0.0.0.0).
> 3. Servers **SHOULD** implement proper authentication for all connections.
> 
> Without these protections, attackers could use DNS rebinding to interact with
> local MCP servers from remote websites.
> 
> ## Sending Messages
> 
> Every JSON-RPC message sent from the client **MUST** be a new HTTP POST
> request to the MCP endpoint.
> 
> 1. The client **MUST** use HTTP POST to send JSON-RPC messages.
> 2. The client **MUST** include an `Accept` header listing both
>    `application/json` and `text/event-stream` as supported content types.
> 3. The client **MUST** include the [request metadata headers](#request-metadata)
>    on each POST request.
> 4. The body of the HTTP POST **MUST** be a single JSON-RPC _request_ or
>    _notification_. The client **MUST NOT** send JSON-RPC _responses_.
> 5. If the body is a JSON-RPC _notification_:
>    - If the server accepts it, the server **MUST** return HTTP status code
>      `202 Accepted` with no body.
>    - If the server cannot accept it, it **MUST** return an HTTP error status
>      code (e.g., `400 Bad Request`). The HTTP response body **MAY** comprise
>      a JSON-RPC _error response_ that has no `id`.
> 6. If the body is a JSON-RPC _request_, the server **MUST** return either
>    `Content-Type: application/json` (a single JSON object) or
>    `Content-Type: text/event-stream` (an SSE response stream). The client
>    **MUST** support both.
> 
> <Note>
> 
> This revision of the core protocol defines no client-to-server
> _notifications_ over Streamable HTTP. The only client-sent notification in
> the core protocol, `notifications/cancelled`, is used only on the
> [stdio](/specification/2026-07-28/basic/transports/stdio) transport; on
> Streamable HTTP, closing the SSE response stream is itself the cancellation
> signal and no `notifications/cancelled` message is expected (see
> [Cancellation][cancellation]). The notification rules above describe the
> transport mechanics for a notification POST; header requirements for
> notification POSTs are not defined by this revision.
> 
> </Note>
> 
> ## Receiving Messages
> 
> When the server returns an SSE response stream
> (`Content-Type: text/event-stream`):
> 
> - The server **MAY** send JSON-RPC _notifications_ — for example,
>   [`notifications/progress`][notifications-progress]
>   or [`notifications/message`][notifications-message] —
>   before the final response. These notifications **MUST** relate to the
>   originating client request.
> - The server **MUST NOT** send independent JSON-RPC _requests_ on this stream.
>   Server-to-client interactions (sampling, elicitation, list-roots) are
>   embedded as input requests inside an
>   [`InputRequiredResult`][input-required-result] per
>   [MRTR][mrtr] ([SEP-2322][sep-2322]), not delivered as separate requests on
>   this or any other stream. This is a change from Streamable HTTP in protocol
>   versions `2025-03-26` through `2025-11-25`, where servers could send such
>   requests on SSE streams.
> - The final JSON-RPC _response_ **SHOULD** terminate the stream.
> 
> Long-lived notification streams are obtained by sending a
> [`subscriptions/listen`][subscriptions-listen]
> request. The server's response is itself an SSE stream that stays open and
> delivers the change notifications the client opted in to (such as
> `notifications/tools/list_changed` or `notifications/resources/updated`).
> Request-scoped notifications like `notifications/progress` and
> `notifications/message` are **not** delivered on the listen stream — they
> flow only on the response stream of the request they relate to.
> 
> When initiating an SSE stream, servers **SHOULD** include the
> `X-Accel-Buffering: no` header in the HTTP response. This instructs reverse
> proxies (such as nginx) to disable res

<a id="evidence-5"></a>

### 5. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 6918–7800

> lines and must not treat them as malformed input.
> 
> </Note>
> 
> Resumable SSE streams via `Last-Event-ID` are not supported.
> 
> [notifications-progress]: /specification/2026-07-28/basic/patterns/progress
> [notifications-message]: /specification/2026-07-28/server/utilities/logging
> [input-required-result]: /specification/2026-07-28/schema#inputrequiredresult
> [mrtr]: /specification/2026-07-28/basic/patterns/mrtr
> [sep-2322]: /seps/2322-MRTR
> [subscriptions-listen]: /specification/2026-07-28/basic/patterns/subscriptions
> 
> ## Message Flow
> 
> The following diagrams illustrate the message flows on a single MCP endpoint.
> 
> **Requests and responses.** Each request is its own POST; the server chooses
> per request whether to respond with a single JSON object or an SSE stream:
> 
> ```mermaid
> sequenceDiagram
>     participant Client
>     participant Server
> 
>     note over Client,Server: Simple response

<a id="evidence-6"></a>

### 6. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 9561–10435

> Client->>Server: POST subscriptions/listen<br/>(notification filter)
>     Server-->>Client: SSE: notifications/subscriptions/acknowledged
>     note over Client,Server: Stream stays open
>     Server-->>Client: SSE: notifications/tools/list_changed
>     Server-->>Client: SSE: notifications/resources/updated
>     note over Client,Server: Until the client or server closes the stream
> ```
> 
> ## Cancellation
> 
> Closing the SSE response stream **MUST** be treated by the server as
> cancellation of that request. Because each request has its own response
> stream, the transport-level disconnect is unambiguous. The server **SHOULD**
> stop work on the cancelled request as soon as practical and **MUST NOT** send
> any further messages for it. See
> [Cancellation][cancellation] for the full rules.
> 
> [cancellation]: /specification/2026-07-28/basic/patterns/cancellation
> 
> ## Request Metadata

<a id="evidence-7"></a>

### 7. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 10400–12000

> // when sessionId is not set (undefined), it means the transport is in stateless mode
>     private sessionIdGenerator: (() => string) | undefined;
>     private _started: boolean = false;
>     private _hasHandledRequest: boolean = false;
>     private _closed: boolean = false;
>     private _streamMapping: Map<string, StreamMapping> = new Map();
>     private _requestToStreamMapping: Map<RequestId, string> = new Map();
>     private _requestResponseMap: Map<RequestId, JSONRPCMessage> = new Map();
>     private _initialized: boolean = false;
>     private _enableJsonResponse: boolean = false;
>     private _standaloneSseStreamId: string = '_GET_stream';
>     private _eventStore?: EventStore;
>     private _onsessioninitialized?: ((sessionId: string) => void | Promise<void>) | undefined;
>     private _onsessionclosed?: ((sessionId: string) => void | Promise<void>) | undefined;
>     private _allowedHosts?: string[];
>     private _allowedOrigins?: string[];
>     private _enableDnsRebindingProtection: boolean;
>     private _retryInterval?: number;
>     private _supportedProtocolVersions: string[];
>     private _keepAliveMs: number;
>     private _maxRequestBodySize: number;
>     private _scopeChallengeResolver?: ScopeChallengeHandler;
> 
>     sessionId?: string;
>     onclose?: () => void;
>     onerror?: (error: Error) => void;
>     onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
> 
>     constructor(options: WebStandardStreamableHTTPServerTransportOptions = {}) {
>         this.sessionIdGenerator = options.sessionIdGenerator;
>         this._enableJsonResponse = options.enableJsonResponse ?? fal

<a id="evidence-8"></a>

### 8. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 3400–9000

> session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
>      *
>      * If not provided, session management is disabled (stateless mode).
>      */
>     sessionIdGenerator?: (() => string) | undefined;
> 
>     /**
>      * A callback for session initialization events
>      * This is called when the server initializes a new session.
>      * Useful in cases when you need to register multiple mcp sessions
>      * and need to keep track of them.
>      * @param sessionId The generated session ID
>      */
>     onsessioninitialized?: ((sessionId: string) => void | Promise<void>) | undefined;
> 
>     /**
>      * A callback for session close events
>      * This is called when the server closes a session due to a `DELETE` request.
>      * Useful in cases when you need to clean up resources associated with the session.
>      * Note that this is different from the transport closing, if you are handling
>      * HTTP requests from multiple nodes you might want to close each
>      * {@linkcode WebStandardStreamableHTTPServerTransport} after a request is completed while still keeping the
>      * session open/running.
>      * @param sessionId The session ID that was closed
>      */
>     onsessionclosed?: ((sessionId: string) => void | Promise<void>) | undefined;
> 
>     /**
>      * If `true`, the server will return JSON responses instead of starting an SSE stream.
>      * This can be useful for simple request/response scenarios without streaming.
>      * Default is `false` (SSE streams are preferred).
>      */
>     enableJsonResponse?: boolean;
> 
>     /**
>      * Event store for resumability support
>      * If provided, resumability will be enabled, allowing clients to reconnect and resume messages
>      */
>     eventStore?: EventStore;
> 
>     /**
>      * List of allowed `Host` header values for DNS rebinding protection.
>      * If not specified, host validation is disabled.
>      * @deprecated Use external middleware for host validation instead.
>      */
>     allowedHosts?: string[];
> 
>     /**
>      * List of allowed `Origin` header values for DNS rebinding protection.
>      * If not specified, origin validation is disabled.
>      * @deprecated Use external middleware for origin validation instead.
>      */
>     allowedOrigins?: string[];
> 
>     /**
>      * Enable DNS rebinding protection (requires `allowedHosts` and/or `allowedOrigins` to be configured).
>      * Default is `false` for backwards compatibility.
>      * @deprecated Use external middleware for DNS rebinding protection instead.
>      */
>     enableDnsRebindingProtection?: boolean;
> 
>     /**
>      * Retry interval in milliseconds to suggest to clients in SSE `retry` field.
>      * When set, the server will send a `retry` field in SSE priming events to control
>      * client reconnection timing for polling behavior.
>      */
>     retryInterval?: number;
> 
>     /**
>      * Interval in milliseconds between SSE keep-alive comment frames.
>      * Defaults to `15000`; set to `0` to disable.
>      */
>     keepAliveMs?: number;
> 
>     /**
>      * Upper bound, in bytes, on a POST body the transport reads itself. A body
>      * over the bound (declared `Content-Length`, or observed while streaming)
>      * is answered `413` before anything is parsed. Not applied when the caller
>      * supplies `parsedBody`. Must be a positive number.
>      * @default 4194304 (4 MiB)
>      */
>     maxRequestBodySize?: number;
> 
>     /**
>      * List of protocol versions that this transport will accept.
>      * Used to validate the `mcp-protocol-version` header in incoming requests.
>      *
>      * Note: When using {@linkcode server/server.Server.connect | Server.connect()}, the server automatically passes its
>      * `supportedProtocolVersions` to the transport, so you typically don't need
>      * to set this option directly.
>      *
>      * @default {@linkcode SUPPORTED_PROTOCOL_VERSIONS}
>      */
>     supportedProtocolVersions?: string[];
> }
> 
> /**
>  * Options for handling a request
>  */
> export interface HandleRequestOptions {
>     /**
>      * Pre-parsed request body. If provided, the transport will use this instead of reading and parsing the request body.
>      * Useful when using body-parser middleware that has already parsed the body.
>      */
>     parsedBody?: unknown;
> 
>     /**
>      * Authentication info from middleware. If provided, will be passed to message handlers.
>      */
>     authInfo?: AuthInfo;
> }
> 
> /**
>  * Server transport for Web Standards Streamable HTTP: this implements the MCP Streamable HTTP transport specification
>  * using Web Standard APIs (`Request`, `Response`, `ReadableStream`).
>  *
>  * This transport works on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun, etc.
>  *
>  * In stateful mode:
>  * - Session ID is generated and included in response headers
>  * - Session ID is always included in initialization responses
>  * - Requests with invalid session IDs are rejected with `404 Not Found`
>  * - Non-initialization requests without a session ID are rejected with `400 Bad Request`
>  * - State is maintained in-memory (connections, message history)
>  *
>  * In stateless mode:
>  * - No Session ID is included in any responses
>  * - No session validation is performed
>  *
>  * @example Stateful setup
>  * ```ts source="./streamableHttp.examples.ts#WebStandardStreamableHTTPServerTransport_stateful"
>  * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
>  *
>  * const transport = new WebStandardStreamableHTTPServerTransport({
>  *     sessionIdGenerator: () => crypto.randomUUID()
>  * });
>  *
>  * await server.connect(transport);
>  * ```
>  *
>  * @example Stateless setup
>  * ``

<a id="evidence-9"></a>

### 9. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 35500–40500

> if (Array.isArray(rawMessage) && rawMessage.length > MAX_BATCH_SIZE) {
>                 this.onerror?.(new Error(`Invalid Request: Batch must not exceed ${MAX_BATCH_SIZE} messages`));
>                 return this.createJsonErrorResponse(400, -32_600, `Invalid Request: Batch must not exceed ${MAX_BATCH_SIZE} messages`);
>             }
> 
>             let messages: JSONRPCMessage[];
> 
>             // handle batch and single messages
>             try {
>                 messages = Array.isArray(rawMessage)
>                     ? rawMessage.map(msg => JSONRPCMessageSchema.parse(msg))
>                     : [JSONRPCMessageSchema.parse(rawMessage)];
>             } catch (error) {
>                 this.onerror?.(error as Error);
>                 return this.createJsonErrorResponse(400, -32_700, 'Parse error: Invalid JSON-RPC message');
>             }
> 
>             if (this._closed) {
>                 return this.createJsonErrorResponse(404, -32_001, 'Session not found');
>             }
> 
>             // Check if this is an initialization request
>             // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/
>             // The schema-validated guard (types/guards.ts → types/schemas.ts —
>             // NOT a wire/rev* import) gates a transport state mutation: a
>             // malformed `initialize` must NOT set `_initialized = true` before
>             // the protocol layer rejects it.
>             const isInitializationRequest = messages.some(element => isInitializeRequest(element));
>             if (isInitializationRequest) {
>                 // If it's a server with session management and the session ID is already set we should reject the request
>                 // to avoid re-initialization.
>                 if (this._initialized && this.sessionId !== undefined) {
>                     this.onerror?.(new Error('Invalid Request: Server already initialized'));
>                     return this.createJsonErrorResponse(400, -32_600, 'Invalid Request: Server already initialized');
>                 }
>                 if (messages.length > 1) {
>                     this.onerror?.(new Error('Invalid Request: Only one initialization request is allowed'));
>                     return this.createJsonErrorResponse(400, -32_600, 'Invalid Request: Only one initialization request is allowed');
>                 }
>                 this.sessionId = this.sessionIdGenerator?.();
>                 this._initialized = true;
> 
>                 // If we have a session ID and an onsessioninitialized handler, call it immediately
>                 // This is needed in cases where the server needs to keep track of multiple sessions
>                 if (this.sessionId && this._onsessioninitialized) {
>                     await Promise.resolve(this._onsessioninitialized(this.sessionId));
>                 }
>             }
>             if (!isInitializationRequest) {
>                 // If an Mcp-Session-Id is returned by the server during initialization,
>                 // clients using the Streamable HTTP transport MUST include it
>                 // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
>                 const sessionError = this.validateSession(req);
>                 if (sessionError) {
>                     return sessionError;
>                 }
>                 // Mcp-Protocol-Version header is required for all requests after initialization.
>                 const protocolError = this.validateProtocolVersion(req);
>                 if (protocolError) {
>                     return protocolError;
>                 }
>             }
> 
>             if (this._closed) {
>                 return this.createJsonErrorResponse(404, -32_001, 'Session not found');
>             }
> 
>             // Check before opening SSE so an insufficient token can receive HTTP 403.
>             let scopeChallengeResponse: Response | undefined;
>             try {
>                 scopeChallengeResponse = await this._checkScopeChallenge(messages, options?.authInfo);
>             } catch (error) {
>                 this.onerror?.(error as Error);
>                 return this.createJsonErrorResponse(500, -32_603, 'Internal server error');
>             }
>             if (scopeChallengeResponse) {
>                 return scopeChallengeResponse;
>             }
> 
>             // check if it contains requests
>             const hasRequests = messages.some(element => isJSONRPCRequest(element));
> 
>             if (!hasRequests) {
>                 // if it only contains notifications or responses, return 202
>                 for (const message of messages) {
>                     this.onmessage?.(message, { authInfo: options?.authInfo, request });
>                 }
>                 return new Response(null, { status: 202 });
>             }
> 
>             // The default behavior is to use SSE streaming
>             // but in some cases server will return JSON responses
>             const streamId = crypto.randomUUID();
> 
>             // Extract protocol version for priming event decision.

<a id="evidence-10"></a>

### 10. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 51500–56500

> if (requestId === undefined) {
>             // For standalone SSE streams, we can only send requests and notifications
>             if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
>                 throw new Error('Cannot send a response on a standalone SSE stream unless resuming a previous client request');
>             }
> 
>             // Generate and store event ID if event store is provided
>             // Store even if stream is disconnected so events can be replayed on reconnect
>             let eventId: string | undefined;
>             if (this._eventStore) {
>                 // Stores the event and gets the generated event ID
>                 eventId = await this._eventStore.storeEvent(this._standaloneSseStreamId, message);
>             }
> 
>             const standaloneSse = this._streamMapping.get(this._standaloneSseStreamId);
>             if (standaloneSse === undefined) {
>                 // Stream is disconnected - event is stored for replay, nothing more to do
>                 return;
>             }
> 
>             // Send the message to the standalone SSE stream — unless the
>             // resumed stream's replay already delivered this exact eventId
>             // (identity dedup; mirrors the per-request path below).
>             if (
>                 standaloneSse.controller &&
>                 standaloneSse.encoder &&
>                 (eventId === undefined || !standaloneSse.replayedEventIds?.has(eventId))
>             ) {
>                 this.writeSSEEvent(standaloneSse.controller, standaloneSse.encoder, message, eventId);
>             }
>             return;
>         }
> 
>         // Get the response for this request
>         const streamId = this._requestToStreamMapping.get(requestId);
>         if (!streamId) {
>             throw new Error(`No connection established for request ID: ${String(requestId)}`);
>         }
> 
>         let stream = this._streamMapping.get(streamId);
> 
>         if (!this._enableJsonResponse) {
>             // Store FIRST so request-related events emitted while the per-request
>             // stream is disconnected (e.g. after `closeSSE()` or a transient
>             // client drop) are replayed on Last-Event-ID reconnect — same
>             // store-first semantics as the standalone path above. Storage is
>             // keyed on request-in-flight (`_requestToStreamMapping` resolved
>             // `streamId` above), not on whether a live SSE writer currently
>             // exists: `_streamMapping` tracks the delivery target only. Per
>             // 2025-11-25 transports.mdx, disconnection SHOULD NOT be
>             // interpreted as the client cancelling its request.
>             let eventId: string | undefined;
>             if (this._eventStore) {
>                 eventId = await this._eventStore.storeEvent(streamId, message);
>                 // Re-read after the await: a Last-Event-ID reconnect during
>                 // storeEvent() may have registered a resumed stream under this
>                 // streamId (mirrors the standalone path's post-await read).
>                 stream = this._streamMapping.get(streamId);
>             }
>             // Write the event to the response stream — unless the resumed
>             // stream's replay already delivered this exact eventId (the store
>             // committed before replay scanned, so replay wrote it; identity
>             // dedup only, no ordering assumption).
>             if (stream?.controller && stream?.encoder && (eventId === undefined || !stream.replayedEventIds?.has(eventId))) {
>                 this.writeSSEEvent(stream.controller, stream.encoder, message, eventId);
>             }
>         }
> 
>         if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
>             this._requestResponseMap.set(requestId, message);
>             const relatedIds = [...this._requestToStreamMapping.entries()].filter(([_, sid]) => sid === streamId).map(([id]) => id);
> 
>             // Check if we have responses for all requests using this connection
>             const allResponsesReady = relatedIds.every(id => this._requestResponseMap.has(id));
> 
>             if (allResponsesReady) {
>                 if (!stream) {
>                     if (this._enableJsonResponse) {
>                         // JSON-mode requires a resolveJson sink; with no stream entry the
>                         // response is undeliverable.
>                         throw new Error(`No connection established for request ID: ${String(requestId)}`);
>                     }
>                     if (!this._eventStore) {
>                         // SSE-mode with no live writer and no event store: the
>                         // response is undeliverable AND not stored. Surface via
>                         // onerror so the drop is observable (matching pre-PR
>                         // behaviour), then run the bookkeeping cleanup so the
>                         // request id is retired.
>                         this.onerror?.(
>                             new Error(

<a id="evidence-11"></a>

### 11. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 46500–51500

> handleDeleteRequest(req: Request): Promise<Response> {
>         const sessionError = this.validateSession(req);
>         if (sessionError) {
>             return sessionError;
>         }
>         const protocolError = this.validateProtocolVersion(req);
>         if (protocolError) {
>             return protocolError;
>         }
> 
>         try {
>             await Promise.resolve(this._onsessionclosed?.(this.sessionId!));
>             return new Response(null, { status: 200 });
>         } finally {
>             await this.close();
>         }
>     }
> 
>     /**
>      * Validates session ID for non-initialization requests.
>      * Returns `Response` error if invalid, `undefined` otherwise
>      */
>     private validateSession(req: Request): Response | undefined {
>         if (this.sessionIdGenerator === undefined) {
>             // If the sessionIdGenerator ID is not set, the session management is disabled
>             // and we don't need to validate the session ID
>             return undefined;
>         }
>         if (!this._initialized) {
>             // If the server has not been initialized yet, reject all requests
>             this.onerror?.(new Error('Bad Request: Server not initialized'));
>             return this.createJsonErrorResponse(400, -32_000, 'Bad Request: Server not initialized');
>         }
> 
>         const sessionId = req.headers.get('mcp-session-id');
> 
>         if (!sessionId) {
>             // Non-initialization requests without a session ID should return 400 Bad Request
>             this.onerror?.(new Error('Bad Request: Mcp-Session-Id header is required'));
>             return this.createJsonErrorResponse(400, -32_000, 'Bad Request: Mcp-Session-Id header is required');
>         }
> 
>         if (sessionId !== this.sessionId) {
>             // Reject requests with invalid session ID with 404 Not Found
>             this.onerror?.(new Error('Session not found'));
>             return this.createJsonErrorResponse(404, -32_001, 'Session not found');
>         }
> 
>         return undefined;
>     }
> 
>     /**
>      * Validates the `MCP-Protocol-Version` header on incoming requests.
>      *
>      * For initialization: Version negotiation handles unknown versions gracefully
>      * (server responds with its supported version).
>      *
>      * For subsequent requests with `MCP-Protocol-Version` header:
>      * - Accept if in supported list
>      * - 400 if unsupported
>      *
>      * For HTTP requests without the `MCP-Protocol-Version` header:
>      * - Accept and default to the version negotiated at initialization
>      */
>     private validateProtocolVersion(req: Request): Response | undefined {
>         const protocolVersion = req.headers.get('mcp-protocol-version');
> 
>         if (protocolVersion !== null && !this._supportedProtocolVersions.includes(protocolVersion)) {
>             const error = `Bad Request: Unsupported protocol version: ${protocolVersion} (supported versions: ${this._supportedProtocolVersions.join(', ')})`;
>             this.onerror?.(new Error(error));
>             return this.createJsonErrorResponse(400, -32_000, error);
>         }
>         return undefined;
>     }
> 
>     async close(): Promise<void> {
>         if (this._closed) {
>             return;
>         }
>         this._closed = true;
> 
>         // Close all SSE connections
>         for (const { cleanup } of this._streamMapping.values()) {
>             cleanup();
>         }
>         this._streamMapping.clear();
> 
>         // Clear any pending responses
>         this._requestResponseMap.clear();
>         this.onclose?.();
>     }
> 
>     /**
>      * Close an SSE stream for a specific request, triggering client reconnection.
>      * Use this to implement polling behavior during long-running operations -
>      * client will reconnect after the retry interval specified in the priming event.
>      */
>     closeSSEStream(requestId: RequestId): void {
>         const streamId = this._requestToStreamMapping.get(requestId);
>         if (!streamId) return;
> 
>         const stream = this._streamMapping.get(streamId);
>         if (stream) {
>             stream.cleanup();
>         }
>     }
> 
>     /**
>      * Close the standalone `GET` SSE stream, triggering client reconnection.
>      * Use this to implement polling behavior for server-initiated notifications.
>      */
>     closeStandaloneSSEStream(): void {
>         const stream = this._streamMapping.get(this._standaloneSseStreamId);
>         if (stream) {
>             stream.cleanup();
>         }
>     }
> 
>     async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
>         let requestId = options?.relatedRequestId;
>         if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
>             // If the message is a response, use the request ID from the message
>             requestId = message.id;
>         }
> 
>         // Check if this message should be sent on the standalone SSE stream (no request ID)
>         // Ignore notifications from tools (which have relatedRequestId set)
>         // Those will be sent via dedicated response SSE streams

<a id="evidence-12"></a>

### 12. MCP OAuth: how MCP authentication works

https://scalar.com/learn/mcp/mcp-oauth · retrieved 2026-11-22 · text offsets 4352–5197

> It accepts access tokens and rejects requests without a valid one.
> - The **MCP client**, inside a host such as Claude Code, Cursor or VS Code, is an OAuth 2.1 *client* acting on behalf of the user.
> - The **authorization server** signs users in and issues tokens. It can be run by the same provider as the MCP server or be a separate identity provider. The spec deliberately does not care which.
> 
> That separation is the most important idea in the whole specification. The first authorization revision, 2025-03-26, leaned towards the MCP server acting as its own authorization server. Since 2025-06-18 the server only has to point at one, which means you can put an MCP server in front of an existing identity provider instead of building login from scratch.
> 
> ## The standards MCP authorization builds on
> 
> MCP does not invent a new auth protocol.

<a id="evidence-13"></a>

### 13. streamableHttp | MCP TypeScript SDK

https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/node/streamableHttp.html · retrieved 2026-11-22 · text offsets 0–882

> [MCP TypeScript SDK (V2)](./../../) / [@modelcontextprotocol/node](./) / streamableHttp
> 
> ## Classes [​](#classes)
> 
> ### NodeStreamableHTTPServerTransport [​](#nodestreamablehttpservertransport)
> 
> Defined in: [packages/middleware/node/src/streamableHttp.ts:78](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/packages/middleware/node/src/streamableHttp.ts#L78)
> 
> Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification. It supports both SSE streaming and direct HTTP responses.
> 
> This is a wrapper around [`WebStandardStreamableHTTPServerTransport`](./../server/server/streamableHttp.html#webstandardstreamablehttpservertransport) that provides Node.js HTTP compatibility. It uses the `@hono/node-server` library to convert between Node.js HTTP and Web Standard APIs.
> 
> In stateful mode:

<a id="evidence-14"></a>

### 14. stdio

https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-03-26/basic/transports.mdx · retrieved 2026-11-22 · text offsets 6074–6944

> The client **MUST** include an `Accept` header, listing `text/event-stream` as a
>    supported content type.
> 3. The server **MUST** either return `Content-Type: text/event-stream` in response to
>    this HTTP GET, or else return HTTP 405 Method Not Allowed, indicating that the server
>    does not offer an SSE stream at this endpoint.
> 4. If the server initiates an SSE stream:
>    - The server **MAY** send JSON-RPC _requests_ and _notifications_ on the stream. These
>      _requests_ and _notifications_ **MAY** be
>      [batched](https://www.jsonrpc.org/specification#batch).
>    - These messages **SHOULD** be unrelated to any concurrently-running JSON-RPC
>      _request_ from the client.
>    - The server **MUST NOT** send a JSON-RPC _response_ on the stream **unless**
>      [resuming](#resumability-and-redelivery) a stream associated with a previous client
>      request.

<a id="evidence-15"></a>

### 15. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 7800–13000

> Client->>Server: POST tools/call (JSON-RPC request)
>     Server-->>Client: 200 OK, application/json<br/>JSON-RPC response
> 
>     note over Client,Server: Streaming response
>     Client->>Server: POST tools/call (JSON-RPC request)
>     note over Server: Opens SSE stream<br/>scoped to this request
>     Server-->>Client: SSE: notifications/progress
>     Server-->>Client: SSE: notifications/progress
>     Server-->>Client: SSE: JSON-RPC response
>     note over Client,Server: Stream closes
> 
>     note over Client,Server: Notification
>     Client->>Server: POST (JSON-RPC notification)
>     Server-->>Client: 202 Accepted
> ```
> 
> **Server-to-client interactions (MRTR).** When the server needs input from
> the client — sampling, elicitation, or roots — it does not send its own
> JSON-RPC request. It returns an
> [`InputRequiredResult`][input-required-result] containing `inputRequests`,
> and the client retries the original request with the matching
> `inputResponses` (see [Multi Round-Trip Requests][mrtr]):
> 
> ```mermaid
> sequenceDiagram
>     participant Client
>     participant Server
> 
>     Client->>Server: POST tools/call (id: 1)
>     note over Server: Needs user input or<br/>an LLM completion
>     Server-->>Client: InputRequiredResult<br/>(inputRequests: elicitation/create)
>     note over Client: Gathers the requested input
>     Client->>Server: POST tools/call (id: 2)<br/>(original params + inputResponses)
>     Server-->>Client: Final result
> ```
> 
> **Change notifications.** Clients that want server-initiated change
> notifications open a long-lived stream with
> [`subscriptions/listen`][subscriptions-listen]; the response stream stays
> open and carries only the notification types the client opted in to:
> 
> ```mermaid
> sequenceDiagram
>     participant Client
>     participant Server
> 
>     Client->>Server: POST subscriptions/listen<br/>(notification filter)
>     Server-->>Client: SSE: notifications/subscriptions/acknowledged
>     note over Client,Server: Stream stays open
>     Server-->>Client: SSE: notifications/tools/list_changed
>     Server-->>Client: SSE: notifications/resources/updated
>     note over Client,Server: Until the client or server closes the stream
> ```
> 
> ## Cancellation
> 
> Closing the SSE response stream **MUST** be treated by the server as
> cancellation of that request. Because each request has its own response
> stream, the transport-level disconnect is unambiguous. The server **SHOULD**
> stop work on the cancelled request as soon as practical and **MUST NOT** send
> any further messages for it. See
> [Cancellation][cancellation] for the full rules.
> 
> [cancellation]: /specification/2026-07-28/basic/patterns/cancellation
> 
> ## Request Metadata
> 
> The Streamable HTTP transport mirrors selected JSON-RPC body fields into HTTP
> headers so that intermediaries (load balancers, gateways, observability
> tooling) can route and inspect requests without parsing the body.
> 
> ### Protocol Version Header
> 
> Every POST request to the MCP endpoint **MUST** include an
> `MCP-Protocol-Version` header.
> 
> For example: `MCP-Protocol-Version: 2026-07-28`
> 
> The header value **MUST** match the
> `io.modelcontextprotocol/protocolVersion` field carried in the request body's
> `_meta`. If the values do not match, the server **MUST** reject the request
> with `400 Bad Request` and a `HeaderMismatch` JSON-RPC error
> (see [Server Validation](#server-validation)).
> 
> If the server does not implement the requested protocol version (whether the
> version is unknown to the server, or is a known version the server has chosen
> not to support), it **MUST** respond with `400 Bad Request` and an
> [`UnsupportedProtocolVersionError`][unsupported-version]
> listing its supported versions. See
> [Versioning: Protocol Version Negotiation][lifecycle-version]
> for the negotiation flow.
> 
> If the server does not implement the requested RPC method, it **MUST** respond
> with `404 Not Found` and a JSON-RPC error with code `-32601`
> (`Method not found`). The JSON-RPC error body distinguishes this case from a
> `404` returned by a legacy [HTTP+SSE][http-sse] server that does not host the
> modern MCP endpoint (see [Backward Compatibility](#backward-compatibility)).
> 
> A server that supports clients implementing protocol versions earlier than
> `2025-06-18` (which did not define the `MCP-Protocol-Version` header) **MAY**
> treat a request that omits the header as protocol version `2025-03-26`. A
> server that does not support such clients **MUST** reject a request without
> the header per [Server Validation](#server-validation).
> 
> [unsupported-version]: /specification/2026-07-28/schema#unsupportedprotocolversionerror
> [lifecycle-version]: /specification/2026-07-28/basic/versioning#protocol-version-negotiation
> 
> ### Standard Request Headers
> 
> | Header Name  | Source Field                  | Required For                                           |
> | ------------ | ----------------------------- | ------------------------------------------------------ |
> | `Mcp-Method` | `method`                      | All requests                                           |
> | `Mcp-Name`   | `params.name` or `params.uri` | `tools/call`, `resources/read`, `prompts/get` requests |
> 
> These headers are **REQUIRED** for compliance.
> 
> If the `Mcp-Name` source value cannot be safely represente

<a id="evidence-16"></a>

### 16. stdio

https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-03-26/basic/transports.mdx · retrieved 2026-11-22 · text offsets 7786–8681

> - If present, the ID **MUST** be globally unique across all streams within that
>      [session](#session-management)—or all streams with that specific client, if session
>      management is not in use.
> 2. If the client wishes to resume after a broken connection, it **SHOULD** issue an HTTP
>    GET to the MCP endpoint, and include the
>    [`Last-Event-ID`](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header)
>    header to indicate the last event ID it received.
>    - The server **MAY** use this header to replay messages that would have been sent
>      after the last event ID, _on the stream that was disconnected_, and to resume the
>      stream from that point.
>    - The server **MUST NOT** replay messages that would have been delivered on a
>      different stream.
> 
> In other words, these event IDs should be assigned by servers on a _per-stream_ basis, to

<a id="evidence-17"></a>

### 17. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 28629–29504

> - A `Last-Event-ID` header: ignore it; streams are not resumable.
> 
> Servers and clients that need to interoperate with counterparts speaking
> those protocol versions implement the behavior described in the corresponding
> revision (for example,
> [2025-11-25: Streamable HTTP](/specification/2025-11-25/basic/transports#streamable-http)),
> in addition to the version-negotiation fallback described above.
> 
> ### HTTP+SSE Transport (2024-11-05)
> 
> <Warning>
>   **Deprecated**: The [HTTP+SSE transport][http-sse] from protocol version
>   2024-11-05 has been deprecated since protocol version `2025-03-26` and is
>   classified as Deprecated under the [feature lifecycle
>   policy](/community/feature-lifecycle#deprecating-a-feature)
>   ([SEP-2596](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2596)).
>   New implementations **SHOULD NOT** adopt it; existing implementations

<a id="evidence-18"></a>

### 18. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 3539–4427

> * If not provided, session management is disabled (stateless mode).
>      */
>     sessionIdGenerator?: (() => string) | undefined;
> 
>     /**
>      * A callback for session initialization events
>      * This is called when the server initializes a new session.
>      * Useful in cases when you need to register multiple mcp sessions
>      * and need to keep track of them.
>      * @param sessionId The generated session ID
>      */
>     onsessioninitialized?: ((sessionId: string) => void | Promise<void>) | undefined;
> 
>     /**
>      * A callback for session close events
>      * This is called when the server closes a session due to a `DELETE` request.
>      * Useful in cases when you need to clean up resources associated with the session.
>      * Note that this is different from the transport closing, if you are handling
>      * HTTP requests from multiple nodes you might want to close each

<a id="evidence-19"></a>

### 19. StreamableHttpServerTransport

https://kotlin.sdk.modelcontextprotocol.io/kotlin-sdk-server/io.modelcontextprotocol.kotlin.sdk.server/-streamable-http-server-transport/index.html · retrieved 2026-11-22 · text offsets 0–856

> Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification. It supports both SSE streaming and direct HTTP responses.
> 
> In stateful mode:
> 
> *   Session ID is generated and included in response headers
>     
> *   Session ID is always included in initialization responses
>     
> *   Requests with invalid session IDs are rejected with 404 Not Found
>     
> *   Non-initialization requests without a session ID are rejected with 400 Bad Request
>     
> *   State is maintained in-memory (connections, message history)
>     
> 
> In stateless mode:
> 
> *   No Session ID is included in any responses
>     
> *   No session validation is performed
>     
> 
> configuration
> 
> Transport configuration. See [Configuration](-configuration/index.html) for available options.
> 
> constructor()
> 
> constructor(enableJsonResponse: [Boolean](https://kotlinlang.

<a id="evidence-20"></a>

### 20. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 17000–19000

> ror));
>                 return this.createJsonErrorResponse(403, -32_000, error);
>             }
>         }
> 
>         return undefined;
>     }
> 
>     /**
>      * Handles an incoming HTTP request, whether `GET`, `POST`, or `DELETE`
>      * Returns a `Response` object (Web Standard)
>      */
>     async handleRequest(req: Request, options?: HandleRequestOptions): Promise<Response> {
>         if (this._closed) {
>             return this.createJsonErrorResponse(404, -32_001, 'Session not found');
>         }
> 
>         // A stateless transport (no sessionIdGenerator) serves exactly one request.
>         if (!this.sessionIdGenerator && this._hasHandledRequest) {
>             throw new Error('Stateless transport cannot be reused across requests. Create a new transport per request.');
>         }
>         this._hasHandledRequest = true;
> 
>         // Validate request headers for DNS rebinding protection
>         const validationError = this.validateRequestHeaders(req);
>         if (validationError) {
>             return validationError;
>         }
> 
>         switch (req.method) {
>             case 'POST': {
>                 return this.handlePostRequest(req, options);
>             }
>             case 'GET': {
>                 return this.handleGetRequest(req);
>             }
>             case 'DELETE': {
>                 return this.handleDeleteRequest(req);
>             }
>             default: {
>                 return this.handleUnsupportedRequest();
>             }
>         }
>     }
> 
>     /**
>      * Returns true if the client's protocol version supports empty SSE data in
>      * priming events (the fix shipped with protocol version `2025-11-25`).
>      *
>      * The version is checked for membership in this transport instance's
>      * supported protocol versions rather than with an open-ended
>      * `>= '2025-11-25'` comparison: the value may come from an `initialize`
>      * request body, which (unlike the `MCP-Protocol-Version` header) is not
>      * validated against `supportedProtocolVersions` before reaching this

<a id="evidence-21"></a>

### 21. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 40500–46000

> // For initialize requests, get from request params.
>             // For other requests, get from header (already validated).
>             const initRequest = messages.find(m => isInitializeRequest(m));
>             const clientProtocolVersion = initRequest
>                 ? initRequest.params.protocolVersion
>                 : (req.headers.get('mcp-protocol-version') ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION);
> 
>             if (this._enableJsonResponse) {
>                 // For JSON response mode, return a Promise that resolves when all responses are ready
>                 return new Promise<Response>(resolve => {
>                     this._streamMapping.set(streamId, {
>                         resolveJson: resolve,
>                         cleanup: () => {
>                             this._streamMapping.delete(streamId);
>                         }
>                     });
> 
>                     for (const message of messages) {
>                         if (isJSONRPCRequest(message)) {
>                             this._requestToStreamMapping.set(message.id, streamId);
>                         }
>                     }
> 
>                     for (const message of messages) {
>                         this.onmessage?.(message, { authInfo: options?.authInfo, request });
>                     }
>                 });
>             }
> 
>             // SSE streaming mode - use ReadableStream with controller for more reliable data pushing
>             const encoder = new TextEncoder();
>             let streamController: ReadableStreamDefaultController<Uint8Array>;
>             let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
> 
>             const readable = new ReadableStream<Uint8Array>({
>                 start: controller => {
>                     streamController = controller;
>                 },
>                 cancel: () => {
>                     if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
>                     // Stream was cancelled by client. Only drop the mapping
>                     // when it still points at THIS controller — a stale cancel
>                     // (firing after a Last-Event-ID reconnect registered a
>                     // resumed stream under the same streamId) must not delete
>                     // the successor.
>                     if (this._streamMapping.get(streamId)?.controller === streamController) {
>                         this._streamMapping.delete(streamId);
>                     }
>                 }
>             });
> 
>             const headers: Record<string, string> = {
>                 'Content-Type': 'text/event-stream',
>                 'Cache-Control': 'no-cache, no-transform',
>                 Connection: 'keep-alive',
>                 'X-Accel-Buffering': 'no'
>             };
> 
>             // After initialization, always include the session ID if we have one
>             if (this.sessionId !== undefined) {
>                 headers['mcp-session-id'] = this.sessionId;
>             }
> 
>             // Store the response for this request to send messages back through this connection
>             // We need to track by request ID to maintain the connection
>             for (const message of messages) {
>                 if (isJSONRPCRequest(message)) {
>                     this._streamMapping.set(streamId, {
>                         controller: streamController!,
>                         encoder,
>                         cleanup: () => {
>                             if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
>                             this._streamMapping.delete(streamId);
>                             try {
>                                 streamController!.close();
>                             } catch {
>                                 // Controller might already be closed
>                             }
>                         }
>                     });
>                     this._requestToStreamMapping.set(message.id, streamId);
>                 }
>             }
> 
>             // Write priming event if event store is configured (after mapping is set up)
>             await this.writePrimingEvent(streamController!, encoder, streamId, clientProtocolVersion);
> 
>             // handle each message
>             for (const message of messages) {
>                 // Build closeSSEStream callback for requests when eventStore is configured
>                 // AND client supports resumability (a supported protocol version >= 2025-11-25).
>                 // Old clients can't resume if the stream is closed early because they
>                 // didn't receive a priming event with an event ID.
>                 let closeSSEStream: (() => void) | undefined;
>                 let closeStandaloneSSEStream: (() => void) | undefined;
>                 if (isJSONRPCRequest(message) && this._eventStore && this.supportsEmptySSEData(clientProtocolVersion)) {
>                     closeSSEStream = () => {
>                         this.closeSSEStream(message.id);
>                     };
>                     closeStandaloneSSEStream = () => {
>                         this.closeStandaloneSSEStream();
>                     };
>                 }
> 
>                 this.onmessage?.(message, { authInfo: options?.authInfo, request, closeSSEStream, closeStandaloneSSEStream });
>             }
>             // The server SHOULD NOT close the SSE stream before sending all JSON-RPC responses
>             // This will be handled by the send() method when responses are ready
> 
>             if (this._streamMapping.get(streamId)?.controller === streamContro

<a id="evidence-22"></a>

### 22. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 6062–6918

> proxies (such as nginx) to disable response buffering, ensuring that SSE
> events are delivered to clients immediately rather than being held in a
> buffer. Without this header, proxies may accumulate messages before sending
> them to the client, introducing unwanted latency and potentially breaking the
> real-time nature of SSE communication.
> 
> <Note>
> 
> For long-lived streams — in particular the
> [`subscriptions/listen`][subscriptions-listen] response stream — servers are
> encouraged to periodically emit an SSE comment line (a line beginning with a
> colon, e.g. `:\r\n`) as a keep-alive. This keeps the connection from being
> closed by intermediaries or client idle timeouts during quiet periods when no
> notifications are flowing. Per the [SSE specification][sse], any line beginning
> with a colon is a comment that carries no event data; clients must ignore such

<a id="evidence-23"></a>

### 23. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 891–1748

> import { MAX_BATCH_SIZE, readRequestBody, requestBodyTooLargeMessage, resolveMaxRequestBodySize } from './requestBody';
> import type { ScopeChallengeHandler } from './scopeChallenge';
> import { createScopeChallengeResponse, findScopeChallenge, scopeChallengeResourceMetadataUrl } from './scopeChallenge';
> import { armSseKeepAlive, DEFAULT_SSE_KEEP_ALIVE_MS } from './sseKeepAlive';
> 
> export type StreamId = string;
> export type EventId = string;
> 
> /**
>  * Interface for resumability support via event storage
>  */
> export interface EventStore {
>     /**
>      * Stores an event for later retrieval
>      * @param streamId ID of the stream the event belongs to
>      * @param message The JSON-RPC message to store
>      * @returns The generated event ID for the stored event
>      */
>     storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;
> 
>     /**

<a id="evidence-24"></a>

### 24. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 19409–20301

> * Only sends if `eventStore` is configured (opt-in for resumability) and
>      * the client's protocol version supports empty SSE data (a supported
>      * version that is >= `2025-11-25`).
>      */
>     private async writePrimingEvent(
>         controller: ReadableStreamDefaultController<Uint8Array>,
>         encoder: InstanceType<typeof TextEncoder>,
>         streamId: string,
>         protocolVersion: string
>     ): Promise<void> {
>         if (!this._eventStore) {
>             return;
>         }
> 
>         // Priming events have empty data which older clients cannot handle.
>         // Only send priming events to clients whose protocol version includes
>         // the fix for handling empty SSE data.
>         if (!this.supportsEmptySSEData(protocolVersion)) {
>             return;
>         }
> 
>         const primingEventId = await this._eventStore.storeEvent(streamId, {} as JSONRPCMessage);

<a id="evidence-25"></a>

### 25. streamableHttp | MCP TypeScript SDK

https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/node/streamableHttp.html · retrieved 2026-11-22 · text offsets 9586–10477

> Use this to implement polling behavior during long-running operations - client will reconnect after the retry interval specified in the priming event.
> 
> ###### Parameters [​](#parameters-4)
> 
> ###### requestId [​](#requestid)
> 
> [`RequestId`](./../../index/@modelcontextprotocol/client/#requestid)
> 
> ###### Returns [​](#returns-9)
> 
> `void`
> 
> ##### closeStandaloneSSEStream() [​](#closestandalonessestream)
> 
> > **closeStandaloneSSEStream**(): `void`
> 
> Defined in: [packages/middleware/node/src/streamableHttp.ts:228](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/packages/middleware/node/src/streamableHttp.ts#L228)
> 
> Close the standalone GET SSE stream, triggering client reconnection. Use this to implement polling behavior for server-initiated notifications.
> 
> ###### Returns [​](#returns-10)
> 
> `void`
> 
> ##### handleRequest() [​](#handlerequest)

<a id="evidence-26"></a>

### 26. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 73689–74573

> The `GET` stream provides cleanup on disconnect, not rate-limiting during the connection.
> 
> ### With EventStreamStore
> 
> [EventStreamStore](../../api/ModelContextProtocol.AspNetCore.HttpServerTransportOptions.html#ModelContextProtocol_AspNetCore_HttpServerTransportOptions_EventStreamStore) is an advanced API that enables session resumability — storing SSE events so clients can reconnect and replay missed messages using the `Last-Event-ID` header. When configured, handlers gain the ability to call `EnablePollingAsync()`, which closes the `POST` response early and switches the client to polling mode.
> 
> When a handler calls `EnablePollingAsync()`:
> 
> *   The `POST` response completes **before the handler finishes**
> *   The handler continues running in the background, decoupled from any HTTP request
> *   The client's HTTP/2 stream slot is freed, allowing it to submit more requests

<a id="evidence-27"></a>

### 27. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 20500–26000

> : \n\n`;
>         }
>         controller.enqueue(encoder.encode(primingEvent));
>     }
> 
>     /**
>      * Handles `GET` requests for SSE stream
>      */
>     private async handleGetRequest(req: Request): Promise<Response> {
>         // The client MUST include an Accept header, listing text/event-stream as a supported content type.
>         const acceptHeader = req.headers.get('accept');
>         if (!acceptHeader?.includes('text/event-stream')) {
>             this.onerror?.(new Error('Not Acceptable: Client must accept text/event-stream'));
>             return this.createJsonErrorResponse(406, -32_000, 'Not Acceptable: Client must accept text/event-stream');
>         }
> 
>         // If an Mcp-Session-Id is returned by the server during initialization,
>         // clients using the Streamable HTTP transport MUST include it
>         // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
>         const sessionError = this.validateSession(req);
>         if (sessionError) {
>             return sessionError;
>         }
>         const protocolError = this.validateProtocolVersion(req);
>         if (protocolError) {
>             return protocolError;
>         }
> 
>         // Handle resumability: check for Last-Event-ID header
>         if (this._eventStore) {
>             const lastEventId = req.headers.get('last-event-id');
>             if (lastEventId) {
>                 return this.replayEvents(lastEventId);
>             }
>         }
> 
>         // Check if there's already an active standalone SSE stream for this session
>         if (this._streamMapping.get(this._standaloneSseStreamId) !== undefined) {
>             // Only one GET SSE stream is allowed per session
>             this.onerror?.(new Error('Conflict: Only one SSE stream is allowed per session'));
>             return this.createJsonErrorResponse(409, -32_000, 'Conflict: Only one SSE stream is allowed per session');
>         }
> 
>         const encoder = new TextEncoder();
>         let streamController: ReadableStreamDefaultController<Uint8Array>;
>         // Captured by cancel/cleanup before it is assigned after stream setup.
>         // eslint-disable-next-line prefer-const
>         let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
> 
>         // Create a ReadableStream with a controller we can use to push SSE events
>         const readable = new ReadableStream<Uint8Array>({
>             start: controller => {
>                 streamController = controller;
>             },
>             cancel: () => {
>                 if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
>                 // Stream was cancelled by client. Only drop the mapping when
>                 // it still points at THIS controller — a stale cancel must not
>                 // delete a successor stream registered by a later GET/resume.
>                 if (this._streamMapping.get(this._standaloneSseStreamId)?.controller === streamController) {
>                     this._streamMapping.delete(this._standaloneSseStreamId);
>                 }
>             }
>         });
> 
>         const headers: Record<string, string> = {
>             'Content-Type': 'text/event-stream',
>             'Cache-Control': 'no-cache, no-transform',
>             Connection: 'keep-alive',
>             'X-Accel-Buffering': 'no'
>         };
> 
>         // After initialization, always include the session ID if we have one
>         if (this.sessionId !== undefined) {
>             headers['mcp-session-id'] = this.sessionId;
>         }
> 
>         // Store the stream mapping with the controller for pushing data
>         this._streamMapping.set(this._standaloneSseStreamId, {
>             controller: streamController!,
>             encoder,
>             cleanup: () => {
>                 if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
>                 this._streamMapping.delete(this._standaloneSseStreamId);
>                 try {
>                     streamController!.close();
>                 } catch {
>                     // Controller might already be closed
>                 }
>             }
>         });
> 
>         keepAliveTimer = this.startKeepAlive(streamController!, encoder);
>         return new Response(readable, { headers });
>     }
> 
>     /**
>      * Replays events that would have been sent after the specified event ID
>      * Only used when resumability is enabled
>      */
>     private async replayEvents(lastEventId: string): Promise<Response> {
>         if (!this._eventStore) {
>             this.onerror?.(new Error('Event store not configured'));
>             return this.createJsonErrorResponse(400, -32_000, 'Event store not configured');
>         }
> 
>         try {
>             // If getStreamIdForEventId is available, use it for conflict checking
>             let streamId: string | undefined;
>             if (this._eventStore.getStreamIdForEventId) {
>                 streamId = await this._eventStore.getStreamIdForEventId(lastEventId);
> 
>                 if (!streamId) {
>                     this.onerror?.(new Error('Invalid event ID format'));
>                     return this.createJsonErrorResponse(400, -32_000, 'Invalid event ID format');
>                 }
> 
>                 // Check conflict with the SAME streamId we'll use for mapping
>                 if (this._streamMapping.get(streamId) !== undefined) {
>                     this.onerror?.(new Error('Conflict: Stream already has an active connection'));
>                     return this.createJsonErrorResponse(409, -32_000, 'Conflict: Stream already has an active connection');
>                 }

<a id="evidence-28"></a>

### 28. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 26500–31000

> er();
>             let streamController: ReadableStreamDefaultController<Uint8Array>;
>             let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
>             let cancelled = false;
>             // Captured by the cancel closure below before it's assigned (after
>             // replayEventsAfter resolves) — must be `let`.
>             // eslint-disable-next-line prefer-const
>             let replayedStreamId: string | undefined;
> 
>             const readable = new ReadableStream<Uint8Array>({
>                 start: controller => {
>                     streamController = controller;
>                 },
>                 cancel: () => {
>                     cancelled = true;
>                     if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
>                     // Stream was cancelled by client — drop the mapping so a
>                     // subsequent reconnect with the same Last-Event-ID is not
>                     // refused with 409 by the conflict check above. Only delete
>                     // when the mapped entry is still THIS closure's controller:
>                     // a stale cancel from an earlier resume must not delete a
>                     // successor resumed stream a re-poll has since registered.
>                     if (replayedStreamId !== undefined && this._streamMapping.get(replayedStreamId)?.controller === streamController) {
>                         this._streamMapping.delete(replayedStreamId);
>                     }
>                 }
>             });
> 
>             // Replay events - returns the streamId for backwards compatibility
>             const replayedEventIds = new Set<string>();
>             replayedStreamId = await this._eventStore.replayEventsAfter(lastEventId, {
>                 send: async (eventId: string, message: JSONRPCMessage) => {
>                     replayedEventIds.add(eventId);
>                     const success = this.writeSSEEvent(streamController!, encoder, message, eventId);
>                     if (!success) {
>                         try {
>                             streamController!.close();
>                         } catch {
>                             // Controller might already be closed
>                         }
>                     }
>                 }
>             });
> 
>             if (this._closed || cancelled) {
>                 try {
>                     streamController!.close();
>                 } catch {
>                     // Controller already closed/cancelled.
>                 }
>                 return this.createJsonErrorResponse(404, -32_001, 'Session not found');
>             }
> 
>             this._streamMapping.get(replayedStreamId)?.cleanup();
>             this._streamMapping.set(replayedStreamId, {
>                 controller: streamController!,
>                 encoder,
>                 replayedEventIds,
>                 cleanup: () => {
>                     if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
>                     this._streamMapping.delete(replayedStreamId!);
>                     try {
>                         streamController!.close();
>                     } catch {
>                         // Controller might already be closed
>                     }
>                 }
>             });
> 
>             // If this is a per-request stream and no in-flight request still
>             // targets this streamId, the request was already retired by the
>             // clean-return path while disconnected and the replay above just
>             // delivered the final response. Per the spec the server SHOULD
>             // close the SSE stream after the JSON-RPC response — close and
>             // unregister so a later reconnect isn't refused with 409. The
>             // standalone GET stream is never request-scoped and stays open.
>             if (replayedStreamId !== this._standaloneSseStreamId) {
>                 const hasInFlightRequest = [...this._requestToStreamMapping.values()].includes(replayedStreamId);
>                 if (!hasInFlightRequest) {
>                     this._streamMapping.delete(replayedStreamId);
>                     try {
>                         streamController!.close();
>                     } catch {
>                         // Controller might already be closed
>                     }
>                 }
>             }
> 
>             if (this._streamMapping.get(replayedStreamId)?.controller === streamController!) {
>                 keepAliveTimer = this.startKeepAlive(streamController!, encoder);
>             }
>             return new Respons

<a id="evidence-29"></a>

### 29. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/streamableHttp.ts · retrieved 2026-11-22 · text offsets 33373–34254

> // Accept is a comma-separated list, so a substring check is the intended semantics here (unlike Content-Type below).
>             // eslint-disable-next-line no-restricted-syntax
>             if (!acceptHeader?.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
>                 this.onerror?.(new Error('Not Acceptable: Client must accept both application/json and text/event-stream'));
>                 return this.createJsonErrorResponse(
>                     406,
>                     -32_000,
>                     'Not Acceptable: Client must accept both application/json and text/event-stream'
>                 );
>             }
> 
>             // Parsed media type, never a substring match — see
>             // isJsonContentType. This check stays here for hand-wired
>             // transports; via createMcpHandler the entry's own check answers

<a id="evidence-30"></a>

### 30. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/1.30.1/src/client/streamableHttp.ts · retrieved 2026-11-22 · text offsets 6000–8600

> ts?.sessionId;
>         this._reconnectionOptions = opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS;
>     }
> 
>     private async _authThenStart(): Promise<void> {
>         if (!this._authProvider) {
>             throw new UnauthorizedError('No auth provider');
>         }
> 
>         let result: AuthResult;
>         try {
>             result = await auth(this._authProvider, {
>                 serverUrl: this._url,
>                 resourceMetadataUrl: this._resourceMetadataUrl,
>                 scope: this._scope,
>                 fetchFn: this._fetchWithInit
>             });
>         } catch (error) {
>             this.onerror?.(error as Error);
>             throw error;
>         }
> 
>         if (result !== 'AUTHORIZED') {
>             throw new UnauthorizedError();
>         }
> 
>         return await this._startOrAuthSse({ resumptionToken: undefined });
>     }
> 
>     private async _commonHeaders(): Promise<Headers> {
>         const headers: HeadersInit & Record<string, string> = {};
>         if (this._authProvider) {
>             const tokens = await this._authProvider.tokens();
>             if (tokens) {
>                 headers['Authorization'] = `Bearer ${tokens.access_token}`;
>             }
>         }
> 
>         if (this._sessionId) {
>             headers['mcp-session-id'] = this._sessionId;
>         }
>         if (this._protocolVersion) {
>             headers['mcp-protocol-version'] = this._protocolVersion;
>         }
> 
>         const extraHeaders = normalizeHeaders(this._requestInit?.headers);
> 
>         return new Headers({
>             ...headers,
>             ...extraHeaders
>         });
>     }
> 
>     private async _startOrAuthSse(options: StartSSEOptions): Promise<void> {
>         const { resumptionToken } = options;
> 
>         try {
>             // Try to open an initial SSE stream with GET to listen for server messages
>             // This is optional according to the spec - server may not support it
>             const headers = await this._commonHeaders();
>             headers.set('Accept', 'text/event-stream');
> 
>             // Include Last-Event-ID header for resumable streams if provided
>             if (resumptionToken) {
>                 headers.set('last-event-id', resumptionToken);
>             }
> 
>             const response = await (this._fetch ?? fetch)(this._url, {
>                 method: 'GET',
>                 headers,
>                 signal: this._abortController?.signal
>             });
> 
>             if (!response.ok) {
>                 await response.body?.cancel();
> 
>                 if (response.status === 401 && this._authProvider) {
>                     // Need to aut

<a id="evidence-31"></a>

### 31. streamableHttp | MCP TypeScript SDK

https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/client/client/streamableHttp.html · retrieved 2026-11-22 · text offsets 25086–25943

> The MCP protocol version to include in the `mcp-protocol-version` header on all requests. When reconnecting with a preserved `sessionId`, set this to the version negotiated during the original handshake so the reconnected transport continues sending the required header.
> 
> ##### reconnectionOptions? [​](#reconnectionoptions)
> 
> > `optional` **reconnectionOptions?**: [`StreamableHTTPReconnectionOptions`](#streamablehttpreconnectionoptions)
> 
> Defined in: [packages/client/src/client/streamableHttp.ts:226](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/packages/client/src/client/streamableHttp.ts#L226)
> 
> Options to configure the reconnection behavior.
> 
> ##### reconnectionScheduler? [​](#reconnectionscheduler-1)
> 
> > `optional` **reconnectionScheduler?**: [`ReconnectionScheduler`](#reconnectionscheduler)

<a id="evidence-32"></a>

### 32. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/1.30.1/src/client/streamableHttp.ts · retrieved 2026-11-22 · text offsets 18800–24800

> eam
>                 this._startOrAuthSse({ resumptionToken, replayMessageId: isJSONRPCRequest(message) ? message.id : undefined }).catch(err =>
>                     this.onerror?.(err)
>                 );
>                 return;
>             }
> 
>             const headers = await this._commonHeaders();
>             headers.set('content-type', 'application/json');
>             headers.set('accept', 'application/json, text/event-stream');
> 
>             const init = {
>                 ...this._requestInit,
>                 method: 'POST',
>                 headers,
>                 body: JSON.stringify(message),
>                 signal: this._abortController?.signal
>             };
> 
>             const response = await (this._fetch ?? fetch)(this._url, init);
> 
>             // Handle session ID received during initialization
>             const sessionId = response.headers.get('mcp-session-id');
>             if (sessionId) {
>                 this._sessionId = sessionId;
>             }
> 
>             if (!response.ok) {
>                 const text = await response.text().catch(() => null);
> 
>                 if (response.status === 401 && this._authProvider) {
>                     // Prevent infinite recursion when server returns 401 after successful auth
>                     if (this._hasCompletedAuthFlow) {
>                         throw new StreamableHTTPError(401, 'Server returned 401 after successful authentication');
>                     }
> 
>                     const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
>                     this._resourceMetadataUrl = resourceMetadataUrl;
>                     this._scope = scope;
> 
>                     const result = await auth(this._authProvider, {
>                         serverUrl: this._url,
>                         resourceMetadataUrl: this._resourceMetadataUrl,
>                         scope: this._scope,
>                         fetchFn: this._fetchWithInit
>                     });
>                     if (result !== 'AUTHORIZED') {
>                         throw new UnauthorizedError();
>                     }
> 
>                     // Mark that we completed auth flow
>                     this._hasCompletedAuthFlow = true;
>                     // Purposely _not_ awaited, so we don't call onerror twice
>                     return this.send(message);
>                 }
> 
>                 if (response.status === 403 && this._authProvider) {
>                     const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);
> 
>                     if (error === 'insufficient_scope') {
>                         const wwwAuthHeader = response.headers.get('WWW-Authenticate');
> 
>                         // Check if we've already tried upscoping with this header to prevent infinite loops.
>                         if (this._lastUpscopingHeader === wwwAuthHeader) {
>                             throw new StreamableHTTPError(403, 'Server returned 403 after trying upscoping');
>                         }
> 
>                         if (scope) {
>                             this._scope = scope;
>                         }
> 
>                         if (resourceMetadataUrl) {
>                             this._resourceMetadataUrl = resourceMetadataUrl;
>                         }
> 
>                         // Mark that upscoping was tried.
>                         this._lastUpscopingHeader = wwwAuthHeader ?? undefined;
>                         const result = await auth(this._authProvider, {
>                             serverUrl: this._url,
>                             resourceMetadataUrl: this._resourceMetadataUrl,
>                             scope: this._scope,
>                             fetchFn: this._fetch
>                         });
> 
>                         if (result !== 'AUTHORIZED') {
>                             throw new UnauthorizedError();
>                         }
> 
>                         return this.send(message);
>                     }
>                 }
> 
>                 throw new StreamableHTTPError(response.status, `Error POSTing to endpoint: ${text}`);
>             }
> 
>             // Reset auth loop flag on successful response
>             this._hasCompletedAuthFlow = false;
>             this._lastUpscopingHeader = undefined;
> 
>             // If the response is 202 Accepted, there's no body to process
>             if (response.status === 202) {
>                 await response.body?.cancel();
>                 // if the accepted notification is initialized, we start the SSE stream
>                 // if it's supported by the server
>                 if (isInitializedNotification(message)) {
>                     // Start without a lastEventId since this is a fresh connection
>                     this._startOrAuthSse({ resumptionToken: undefined }).catch(err => this.onerror?.(err));
>                 }
>                 return;
>             }
> 
>             // Get original message(s) for detecting request IDs
>             const messages = Array.isArray(message) ? message : [message];
> 
>             const hasRequests = messages.filter(msg => 'method' in msg && 'id' in msg && msg.id !== undefined).length > 0;
> 
>             // Check the response type (parsed media type — see mediaTypeEssence)
>             const contentType = response.headers.get('content-type');
>             const responseMediaType = mediaTypeEssence(contentType);
> 
>             if (hasRequests) {
>                 if (responseMediaType === 'text/event-stream') {
>                     // Handle SSE stream responses for requests
>                     // We use the same handler as standalone streams, which now supports
>                     // reconnection with the last event ID
>                     this._handleSseStream(response.body, { onresumptiontoken }, false);
>                 } else if (responseMediaType === 'application/json') {
>                     // For non-streaming servers, we might get direct JSON responses
>                     const data = await response.json();
>                     const responseMessages = Array.isArray(data)

<a id="evidence-33"></a>

### 33. streamableHttp.ts

https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/1.30.1/src/client/streamableHttp.ts · retrieved 2026-11-22 · text offsets 0–883

> import { mediaTypeEssence } from '../shared/mediaType.js';
> import { Transport, FetchLike, createFetchWithInit, normalizeHeaders } from '../shared/transport.js';
> import { isInitializedNotification, isJSONRPCRequest, isJSONRPCResultResponse, JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';
> import { auth, AuthResult, extractWWWAuthenticateParams, OAuthClientProvider, UnauthorizedError } from './auth.js';
> import { EventSourceParserStream } from 'eventsource-parser/stream';
> 
> // Default reconnection options for StreamableHTTP connections
> const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS: StreamableHTTPReconnectionOptions = {
>     initialReconnectionDelay: 1000,
>     maxReconnectionDelay: 30000,
>     reconnectionDelayGrowFactor: 1.5,
>     maxRetries: 2
> };
> 
> export class StreamableHTTPError extends Error {
>     constructor(
>         public readonly code: number | undefined,

<a id="evidence-34"></a>

### 34. streamableHttp | MCP TypeScript SDK

https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/client/client/streamableHttp.html · retrieved 2026-11-22 · text offsets 15522–16413

> com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/packages/client/src/client/streamableHttp.ts#L79)
> 
> Override Message ID to associate with the replay message so that the response can be associated with the new resumed request.
> 
> ##### requestSignal? [​](#requestsignal-1)
> 
> > `optional` **requestSignal?**: `AbortSignal`
> 
> Defined in: [packages/client/src/client/streamableHttp.ts:88](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/packages/client/src/client/streamableHttp.ts#L88)
> 
> The per-request abort signal supplied by the caller via `TransportSendOptions.requestSignal`. When this signal is aborted the originating POST and its SSE response stream are torn down intentionally — `_handleSseStream` treats it exactly like the transport-level abort: no `onerror`, no reconnect.
> 
> ##### resumptionToken?

<a id="evidence-35"></a>

### 35. streamableHttp | MCP TypeScript SDK

https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/client/client/streamableHttp.html · retrieved 2026-11-22 · text offsets 13853–14721

> ts:60](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/packages/client/src/client/streamableHttp.ts#L60)
> 
> Options for starting or authenticating an SSE connection
> 
> #### Properties [​](#properties-1)
> 
> ##### onRequestStreamEnd? [​](#onrequeststreamend-1)
> 
> > `optional` **onRequestStreamEnd?**: () => `void`
> 
> Defined in: [packages/client/src/client/streamableHttp.ts:97](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/packages/client/src/client/streamableHttp.ts#L97)
> 
> The per-request stream-end callback supplied via `TransportSendOptions.onRequestStreamEnd`. Fired when the SSE response stream for the originating POST ends or errors for any non-deliberate reason (server closed, network dropped, reconnection exhausted) — never when `requestSignal` was aborted.

<a id="evidence-36"></a>

### 36. modelcontextprotocol/rust-sdk issue #1476: Streamable HTTP client retries a session-expired (404) SSE resume GET forever and never re-initializes

https://github.com/modelcontextprotocol/rust-sdk/issues/1476 · retrieved 2026-11-22 · text offsets 3410–4223

> Expected (the `InitializeRequest` requirement is a transport-spec MUST; the rest is the client's existing session-recovery design):
> 
> - By the 2025-11-25 transports spec's Session Management rule 4, a `404` for a request carrying `Mcp-Session-Id` must lead to a new session via an `InitializeRequest` without a session ID ([Session Management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management)).
> - The GET recovery loop stops instead of retrying the stale session. A resume GET cannot replay the original request: unlike a POST rejected with `404` (which the existing recovery path retries because the server did not execute it), the original POST here already ran and its response stream is gone, so the interrupted request fails with a meaningful session-expiry error.

<a id="evidence-37"></a>

### 37. modelcontextprotocol/rust-sdk issue #1476: Streamable HTTP client retries a session-expired (404) SSE resume GET forever and never re-initializes

https://github.com/modelcontextprotocol/rust-sdk/issues/1476 · retrieved 2026-11-22 · text offsets 0–853

> #1476 Streamable HTTP client retries a session-expired (404) SSE resume GET forever and never re-initializes
> 
> - type: issue
> - state: OPEN
> - author: BlueX888
> - assignees: Michael Neale
> - created: 2026-11-19T18:47:35Z
> - labels: T-transport, bug, ready for work, P1
> - milestone: none
> - comments: 1; review threads: 0
> 
> ## Body
> ## Summary
> 
> A `StreamableHttpClientTransport` using a legacy (stateful) session retries a `404` on the SSE resume `GET` forever. When the server has terminated the session, the resume `GET` carrying `Mcp-Session-Id` and `Last-Event-ID` gets `404`; the built-in reqwest and Unix-socket clients turn that into a generic HTTP error, `classify_reconnect_error` classifies it as retryable, and the default exponential backoff has no maximum. The reconnect loop never ends, so the in-flight request is never failed and the caller hangs.

<a id="evidence-38"></a>

### 38. modelcontextprotocol/rust-sdk issue #1476: Streamable HTTP client retries a session-expired (404) SSE resume GET forever and never re-initializes

https://github.com/modelcontextprotocol/rust-sdk/issues/1476 · retrieved 2026-11-22 · text offsets 853–1715

> No new `InitializeRequest` is sent, even though the transport spec requires it on a `404` for a request that carried a session ID.
> 
> Baseline: `main` at `7ae99bf8cc195435f777e15546137e192df1e40e` (2026-11-19). The modern session-less bootstrap path is unaffected; this is the legacy stateful session path, which is still supported.
> 
> ## Why this matters
> 
> Long-running `tools/call` requests that emit progress are a typical case: the server restarts or expires the session, the client resumes the SSE stream, gets `404`, and the tool call hangs indefinitely. The SDK's typed peer methods use no timeout (#912), and editors and agents may not add one around a single call, so the whole operation can stall. The spec calls for a new session, and rmcp's own server already answers `404` for an unknown session (`crates/rmcp/src/transport/streamable_http_server/tower.

<a id="evidence-39"></a>

### 39. Deploying a Remote MCP Server: Stateless, Streamable HTTP, and Horizontal Scaling

https://agentscamp.com/guides/mcp/deploy-remote-mcp-server · retrieved 2026-11-22 · text offsets 2314–3191

> - **Stateless** — every request is self-contained. The server keeps no per-session memory between requests; whatever a tool needs, it derives from the authenticated identity plus the request itself. Because no request depends on which instance handled the last one, **any replica can serve any request.** That makes horizontal scaling, load balancing, autoscaling, and serverless deployment trivial, and it survives restarts and crashes without dropping anyone.
> - **Stateful** — the server holds session state in memory, keyed by the `Mcp-Session-Id` header the client carries across requests. This buys you continuity within a session but costs you the easy scaling: now a session is pinned to one process, so you need **sticky routing** (session affinity at the load balancer) or you must **externalize the session state** to a shared store.
> 
> > [!TIP]
> > Default to stateless.

<a id="evidence-40"></a>

### 40. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 26552–27420

> *   `initialize`\-handshake sessions resolve services from the application provider and scope each request, exactly like [stateful HTTP](#stateful-http).
> *   [ConfigureSessionOptions](../../api/ModelContextProtocol.AspNetCore.HttpServerTransportOptions.html#ModelContextProtocol_AspNetCore_HttpServerTransportOptions_ConfigureSessionOptions) runs once per session for `initialize`\-handshake clients and once per HTTP request for `2026-07-28` clients.
> 
> Stateful-only options (`IdleTimeout`, `EventStreamStore`, `SessionMigrationHandler`, and so on) continue to govern the session half of the endpoint and are ignored for `2026-07-28` requests.
> 
> ## Comparison
> 
> Consideration
> 
> Stateless
> 
> Stateful
> 
> **Deployment**
> 
> Any topology — load balancer, serverless, multi-instance
> 
> Requires session affinity (sticky sessions)
> 
> **Scaling**
> 
> Horizontal scaling without constraints

<a id="evidence-41"></a>

### 41. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 0–718

> The MCP [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) uses an `Mcp-Session-Id` HTTP header to associate multiple requests with a single logical session. However, **we recommend most servers disable sessions entirely by setting [SessionMode](../../api/ModelContextProtocol.AspNetCore.HttpServerTransportOptions.html#ModelContextProtocol_AspNetCore_HttpServerTransportOptions_SessionMode) to [Stateless](../../api/ModelContextProtocol.AspNetCore.HttpServerSessionMode.html#ModelContextProtocol_AspNetCore_HttpServerSessionMode_Stateless)**. Stateless mode avoids the complexity, memory overhead, and deployment constraints that come with sessions.

<a id="evidence-42"></a>

### 42. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 9095–9907

> Clients bootstrap by sending `server/discover` instead, and every request carries the negotiated protocol version in the `MCP-Protocol-Version` HTTP header (HTTP transport) or the `_meta.io.modelcontextprotocol/protocolVersion` JSON-RPC field (every transport).
> 
> **Server side.** With `SessionMode = HttpServerSessionMode.Stateless` (the default), the SDK already meets `2026-07-28` on the wire. Any HTTP `POST` that arrives with the `2026-07-28` `MCP-Protocol-Version` header is routed through the stateless path automatically — no session is created, no `Mcp-Session-Id` is returned, and the `GET` and `DELETE` endpoints aren't mapped. Clients that still send `initialize` on the same endpoint continue to work in stateless mode for the lifetime of that single POST. With `SessionMode = HttpServerSessionMode.

<a id="evidence-43"></a>

### 43. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 9907–12000

> Stateful`, the server still creates HTTP sessions when the client speaks `2025-11-25` or earlier — but a `2026-07-28` request on a stateful server is refused with a `-32022 UnsupportedProtocolVersion` error, so a dual-path client downgrades to the `initialize` handshake and obtains a session. `SessionMode = HttpServerSessionMode.StatefulForInitializeClients` opts out of that downgrade and serves the `2026-07-28` request statelessly instead — see [Hybrid mode](#hybrid-mode-sessions-for-initialize-clients-only). If a `2026-07-28` request carries an `Mcp-Session-Id`, the server ignores the header and still does not echo or mint a session ID for that request, in every mode.
> 
> **Stateful options marked obsolete.** Because Streamable HTTP no longer supports sessions starting with the `2026-07-28` revision, the stateful-only knobs on [HttpServerTransportOptions](../../api/ModelContextProtocol.AspNetCore.HttpServerTransportOptions.html) — `IdleTimeout`, `MaxIdleSessionCount`, `EventStreamStore`, `SessionMigrationHandler`, and `PerSessionExecutionContext` — are now marked `[Obsolete]` with diagnostic `MCP9006` to signal that they only apply to initialize-handshake back-compat. You can still set them — the warning is informational — and they continue to govern stateful behavior for initialize-capable clients.
> 
> **Client side — automatic fallback.** Clients automatically probe `2026-07-28` first and fall back to the `initialize` handshake when the server doesn't support it:
> 
> *   **HTTP**: the client sends its first request with the `2026-07-28` `MCP-Protocol-Version` header. If the server returns HTTP `400` with anything other than a structured `-32022` / `-32021` / `-32020` JSON-RPC error, the client switches to the `initialize` flow on the same endpoint.
> *   **stdio**: the client sends a `server/discover` probe with a 5-second timeout. A `DiscoverResult` confirms `2026-07-28`; a `-32022` error with a `supported` payload triggers a retry at the highest mutually-supported initialize-capable version; anything else — including a timeout — falls back to `initialize` on the

<a id="evidence-44"></a>

### 44. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 19422–20216

> Use stateless mode when your server:
> 
> *   Exposes tools that are pure functions (take input, return output)
> *   Doesn't need to ask the client for user input (elicitation) or LLM completions (sampling)
> *   Doesn't need to send unsolicited notifications to the client
> *   Needs to scale horizontally behind a load balancer without session affinity
> *   Is deployed to serverless environments (Azure Functions, AWS Lambda, etc.)
> 
> Most MCP servers fall into this category. Tools that call APIs, query databases, process data, or return computed results are all natural fits for stateless mode. For guidance on choosing between stateless and stateful mode, see [Forward and backward compatibility](#forward-and-backward-compatibility).
> 
> ### Stateless alternatives for server-to-client interactions

<a id="evidence-45"></a>

### 45. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 66759–67649

> Handlers are interrupted mid-execution, and no disposal code runs. This is inherent to process-level termination and not specific to the SDK.
> 
> ### Stateless per-request logging
> 
> In stateless mode, each HTTP request creates and disposes a short-lived `McpServer` instance. This produces session lifecycle log entries at `Trace` level (`session created` / `session disposed`) for every request. These entries are typically invisible at default log levels but might appear when troubleshooting with verbose logging enabled. There is no user-facing `initialize` handshake in stateless mode — the SDK handles the per-request server lifecycle internally.
> 
> ## Tasks and session modes
> 
> [Tasks](../tasks/tasks.html) enable a "call-now, fetch-later" pattern for long-running tool calls. Task support depends on having an [IMcpTaskStore](../../api/ModelContextProtocol.Extensions.Tasks.IMcpTaskStore.

<a id="evidence-46"></a>

### 46. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 34021–34898

> *   A client that tries to use the expired session ID receives a `404 Session not found` error and should start a new session
> 
> You can disable idle timeout by setting it to `Timeout.InfiniteTimeSpan`, though this is not recommended for production deployments.
> 
> #### Maximum idle session count
> 
> [MaxIdleSessionCount](../../api/ModelContextProtocol.AspNetCore.HttpServerTransportOptions.html#ModelContextProtocol_AspNetCore_HttpServerTransportOptions_MaxIdleSessionCount) (default: **10,000**) limits how many idle Streamable HTTP sessions can exist simultaneously. If this limit is exceeded:
> 
> *   A critical error is logged
> *   The oldest idle sessions are terminated (even if they haven't reached their idle timeout)
> *   Termination continues until the idle count is back below the limit
> 
> Sessions with any active HTTP request don't count toward this limit.
> 
> #### Termination

<a id="evidence-47"></a>

### 47. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 82430–83223

> operation.duration`
> 
> Duration of each request/notification on the server
> 
> `mcp.client.operation.duration`
> 
> Duration of each request/notification on the client
> 
> In stateless mode, each HTTP request is its own "session", so `mcp.server.session.duration` measures individual request lifetimes rather than long-lived session durations.
> 
> ## Legacy SSE transport
> 
> The legacy [SSE (Server-Sent Events)](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports#http-with-sse) transport is also supported by `MapMcp()` and always uses stateful mode. Legacy SSE endpoints (`/sse` and `/message`) are **disabled by default** due to [backpressure concerns](#request-backpressure). To enable them, set [EnableLegacySse](../../api/ModelContextProtocol.AspNetCore.HttpServerTransportOptions.

<a id="evidence-48"></a>

### 48. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 1788–2673

> like `https://example.com/mcp`.
> 
> [http-sse]: /specification/2024-11-05/basic/transports#http-with-sse
> [sse]: https://en.wikipedia.org/wiki/Server-sent_events
> 
> ## Security & Endpoint
> 
> When implementing Streamable HTTP transport:
> 
> 1. Servers **MUST** validate the `Origin` header on all incoming connections
>    to prevent DNS rebinding attacks.
>    - If the `Origin` header is present and invalid, servers **MUST** respond
>      with HTTP 403 Forbidden. The HTTP response body **MAY** comprise a
>      JSON-RPC _error response_ that has no `id`.
> 2. When running locally, servers **SHOULD** bind only to localhost
>    (127.0.0.1) rather than all network interfaces (0.0.0.0).
> 3. Servers **SHOULD** implement proper authentication for all connections.
> 
> Without these protections, attackers could use DNS rebinding to interact with
> local MCP servers from remote websites.
> 
> ## Sending Messages

<a id="evidence-49"></a>

### 49. stdio

https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-03-26/basic/transports.mdx · retrieved 2026-11-22 · text offsets 2662–3521

> #### Security Warning
> 
> When implementing Streamable HTTP transport:
> 
> 1. Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks
> 2. When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0)
> 3. Servers **SHOULD** implement proper authentication for all connections
> 
> Without these protections, attackers could use DNS rebinding to interact with local MCP servers from remote websites.
> 
> ### Sending Messages to the Server
> 
> Every JSON-RPC message sent from the client **MUST** be a new HTTP POST request to the
> MCP endpoint.
> 
> 1. The client **MUST** use HTTP POST to send JSON-RPC messages to the MCP endpoint.
> 2. The client **MUST** include an `Accept` header, listing both `application/json` and
>    `text/event-stream` as supported content types.
> 3.

<a id="evidence-50"></a>

### 50. Local MCP over HTTP: Origin Validation Is the DNS Rebinding Boundary

https://mcp-guard.org/blog/mcp-localhost-origin-en · retrieved 2026-11-22 · text offsets 842–1731

> The current MCP Streamable HTTP specification, version `2026-07-28`, sets three distinct expectations: validate the `Origin` header on incoming connections, return HTTP 403 when a present Origin is invalid, bind local deployments to `127.0.0.1` rather than `0.0.0.0`, and use proper authentication. The same protections appear in the final `2025-11-25` transport, so this boundary applies to both common transport generations.
> 
> ## Three controls answer three different questions
> 
> Control
> 
> Question answered
> 
> What it does not prove
> 
> Loopback bind
> 
> Which network interfaces accept traffic?
> 
> Which browser origin initiated a loopback request
> 
> Origin validation
> 
> Is this web origin allowed to call the endpoint?
> 
> Who the user is or what the caller may do
> 
> Authentication and authorization
> 
> Which principal and scopes may invoke a tool?
> 
> That the endpoint is unreachable from other interfaces

<a id="evidence-51"></a>

### 51. Local MCP over HTTP: Origin Validation Is the DNS Rebinding Boundary

https://mcp-guard.org/blog/mcp-localhost-origin-en · retrieved 2026-11-22 · text offsets 1731–2595

> An adoption review should record the actual listening address from the running process or container, not only a framework default. Container port publishing and reverse proxies can turn an internal bind into a LAN-accessible endpoint. When a proxy terminates HTTP, confirm that `Origin` reaches the MCP application unchanged and that validation occurs before JSON-RPC parsing or tool dispatch.
> 
> Use an exact allowlist of complete origins: scheme, hostname, and port. A suffix check such as “ends with example.com,” a wildcard, or reflecting the supplied Origin defeats the boundary. Decide explicitly how requests with no `Origin` are handled. Native MCP clients often omit it, while browsers normally include it; an absent header can be allowed for a documented native-client path, but must not bypass authentication.
> 
> `Host` and `Origin` are not interchangeable.

<a id="evidence-52"></a>

### 52. Local MCP over HTTP: Origin Validation Is the DNS Rebinding Boundary

https://mcp-guard.org/blog/mcp-localhost-origin-en · retrieved 2026-11-22 · text offsets 3447–4259

> Confirm the service is not listening on LAN or wildcard interfaces unless remote access is an intentional, authenticated deployment.
> 
> The official versioning page marks `2026-07-28` as **Current** and `/draft` as not ready for consumption. Draft behavior may evolve, so deployment acceptance should be tied to the negotiated protocol version and the transport implementation that actually runs.
> 
> ## Scope and limits
> 
> Origin validation primarily protects browser-mediated access and DNS rebinding. It does not stop malware or another local process from making direct requests, and it does not sandbox a local MCP process from the filesystem or operating-system credentials. Loopback, Origin, authentication, least-privilege execution, and tool-level authorization remain separate controls.
> 
> ## Related research

<a id="evidence-53"></a>

### 53. MCP OAuth: how MCP authentication works

https://scalar.com/learn/mcp/mcp-oauth · retrieved 2026-11-22 · text offsets 14584–15478

> This is called step-up authorization. The spec asks servers to list every scope an operation needs in one challenge, so the user is not sent through the browser three times for one action. It also recommends keeping `scopes_supported` to the minimum needed for basic use and asking for more only when needed.
> 
> ## Token rules: audience, passthrough and refresh
> 
> Three rules in the [security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) prevent the most serious attacks.
> 
> **Audience binding.** An MCP server MUST only accept tokens issued for itself, and reject tokens whose audience does not include it. Without this, a token a user granted to one MCP server could be replayed against another.
> 
> **No token passthrough.** If your MCP server calls an upstream API, it MUST NOT forward the token it received from the client.

<a id="evidence-54"></a>

### 54. MCP OAuth: how MCP authentication works

https://scalar.com/learn/mcp/mcp-oauth · retrieved 2026-11-22 · text offsets 29225–29992

> <scalar-detail title="Can I use my existing identity provider for MCP authentication?">
> Usually, yes. The MCP server only has to point at an authorization server through protected resource metadata. The identity provider must advertise PKCE support, and ideally support Client ID Metadata Documents or Dynamic Client Registration so clients can register without manual setup.
> </scalar-detail>
> 
> <scalar-detail title="Can an MCP server pass the user's token to my API?">
> No. The specification forbids token passthrough. The MCP server must validate that the token was issued for itself and use a separate credential when it calls an upstream API.
> </scalar-detail>
> 
> <scalar-detail title="How does OAuth work on Scalar MCP servers?">
> Installations are private by default.

<a id="evidence-55"></a>

### 55. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 54990–55750

> // This runs on every request in stateless mode, so you can use the
>             // current HttpContext to customize tools, prompts, or resources.
>             var apiVersion = httpContext.Request.Headers["X-Api-Version"].ToString();
>             mcpServerOptions.ToolCollection = GetToolsForVersion(apiVersion);
>             return Task.CompletedTask;
>         };
>     })
>     .WithTools<DefaultTools>();
> ```
> 
> ### Security and user binding
> 
> #### User binding
> 
> When authentication is configured, the server automatically binds sessions to the authenticated user. This prevents one user from hijacking another user's session.
> 
> ##### How it works
> 
> 1.  When a session is created, the server captures the authenticated user's identity from `HttpContext.User`.

<a id="evidence-56"></a>

### 56. Stateless and stateful mode | MCP C# SDK

https://csharp.sdk.modelcontextprotocol.io/v2/concepts/stateless/stateless.html · retrieved 2026-11-22 · text offsets 56502–57401

> An authenticated principal whose selected claim is missing or empty receives `403 Forbidden` with an error explaining how to add a supported identifier. An empty higher-priority claim is rejected rather than falling back to another claim. This applies to stateful Streamable HTTP and legacy SSE sessions.
> 
> Anonymous and stateless requests do not require a session identity, but anonymous users cannot access authenticated sessions. Session binding does not replace authorization; use `.RequireAuthorization()` to prohibit anonymous access.
> 
> ##### Adding a supported claim with `IClaimsTransformation`
> 
> Use this mapping if your authentication handler supplies `custom-user-id` instead of `NameIdentifier`, `sub`, or UPN. This example assumes a single identity. With authentication and `UseAuthentication()` already configured, register an ASP.NET Core [IClaimsTransformation](https://learn.microsoft.

<a id="evidence-57"></a>

### 57. Deploying a Remote MCP Server: Stateless, Streamable HTTP, and Horizontal Scaling

https://agentscamp.com/guides/mcp/deploy-remote-mcp-server · retrieved 2026-11-22 · text offsets 4088–4875

> - **Validate and bound every input.** The model fills tool arguments; treat them as untrusted. Enforce schemas, cap sizes, and reject anything out of range before it reaches your handler.
> - **Scope least privilege.** A token that can read should not be able to write. Don't expose one all-powerful tool when three scoped ones will do.
> 
> > [!WARNING]
> > The transport gives you no security for free. An unauthenticated remote MCP server is an open, model-callable API over your tools — assume it will be found. Auth, input validation, and per-token scoping are not optional hardening; they are the baseline for being remote at all.
> 
> ## Scaling it: ordinary web ops, once it's stateless
> 
> Here's the payoff of the stateless decision: scaling a remote MCP server is just scaling a web service.

<a id="evidence-58"></a>

### 58. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 13000–16600

> d as a plain ASCII
> header value, clients **MUST** encode it using the Base64 sentinel format
> described in [Value Encoding](#value-encoding).
> 
> **`tools/call` request:**
> 
> ```http
> POST /mcp HTTP/1.1
> Host: example.com
> Content-Type: application/json
> Accept: application/json, text/event-stream
> MCP-Protocol-Version: 2026-07-28
> Mcp-Method: tools/call
> Mcp-Name: get_weather
> 
> {
>   "jsonrpc": "2.0",
>   "id": 1,
>   "method": "tools/call",
>   "params": {
>     "name": "get_weather",
>     "arguments": {
>       "location": "Seattle, WA"
>     },
>     "_meta": {
>       "io.modelcontextprotocol/protocolVersion": "2026-07-28",
>       "io.modelcontextprotocol/clientInfo": {
>         "name": "ExampleClient",
>         "version": "1.0.0"
>       },
>       "io.modelcontextprotocol/clientCapabilities": {}
>     }
>   }
> }
> ```
> 
> **`resources/read` request:**
> 
> ```http
> POST /mcp HTTP/1.1
> Host: example.com
> Content-Type: application/json
> Accept: application/json, text/event-stream
> MCP-Protocol-Version: 2026-07-28
> Mcp-Method: resources/read
> Mcp-Name: file:///projects/myapp/config.json
> 
> {
>   "jsonrpc": "2.0",
>   "id": 2,
>   "method": "resources/read",
>   "params": {
>     "uri": "file:///projects/myapp/config.json",
>     "_meta": {
>       "io.modelcontextprotocol/protocolVersion": "2026-07-28",
>       "io.modelcontextprotocol/clientInfo": {
>         "name": "ExampleClient",
>         "version": "1.0.0"
>       },
>       "io.modelcontextprotocol/clientCapabilities": {}
>     }
>   }
> }
> ```
> 
> ### Custom Headers from Tool Parameters
> 
> MCP servers **MAY** designate specific tool parameters to be mirrored into
> HTTP headers using an `x-mcp-header` extension property in the parameter's
> schema within the tool's `inputSchema`. See
> [Tool Definitions][tool-definitions] for
> details on how to annotate tool parameters.
> 
> While the use of `x-mcp-header` is optional for servers, clients **MUST**
> support this feature. When a server's tool definition includes
> `x-mcp-header` annotations, conforming clients **MUST** mirror the
> designated parameter values into HTTP headers.
> 
> [tool-definitions]: /specification/2026-07-28/server/tools#x-mcp-header
> 
> #### Schema Extension
> 
> The `x-mcp-header` property specifies the name portion used to construct
> the header name `Mcp-Param-{name}`.
> 
> **Constraints on `x-mcp-header` values**:
> 
> - **MUST NOT** be empty
> - **MUST** match HTTP field-name token syntax (`1*tchar`, [RFC 9110 Section 5.1](https://datatracker.ietf.org/doc/html/rfc9110#section-5.1))
> - **MUST NOT** contain control characters, including carriage return (CR, `\r`)
>   or line feed (LF, `\n`)
> - **MUST** be case-insensitively unique among all `x-mcp-header` values in
>   the `inputSchema`
> - **MUST** only be applied to parameters with primitive types (integer,
>   string, boolean). Parameters with type `number` are not permitted.
>   Integer values **MUST** be within the safe range for JavaScript
>   (−2<sup>53</sup>+1 to 2<sup>53</sup>−1)
> - **MUST** only be applied to properties that are _statically reachable_
>   from the schema root: reachable via a chain consisting solely of
>   `properties` keys. The chain **MUST NOT** pass through `items` (or any
>   other array keyword), composition keywords (`oneOf`, `anyOf`, `allOf`,
>   `not`), conditional keywords (`if`/`then`/`else`), or `$ref`. Nested
>   object properties are permitted as long as every step in the chain is a
>   `properties` key. An `x-mcp-header` annotation anywhere else makes the
>   annotation — and thus the tool definition — invalid.
> 
> Header extraction is defined as reading the instance value at the exact
> property path of the annotated property (the chain of `properties` keys
> leading to it). If n

<a id="evidence-59"></a>

### 59. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 17300–23000

> "description": "Execute SQL on Google Cloud Spanner",
>   "inputSchema": {
>     "type": "object",
>     "properties": {
>       "region": {
>         "type": "string",
>         "description": "The region to execute the query in",
>         "x-mcp-header": "Region"
>       },
>       "query": {
>         "type": "string",
>         "description": "The SQL query to execute"
>       }
>     },
>     "required": ["region", "query"]
>   }
> }
> ```
> 
> **Resulting HTTP request:**
> 
> ```http
> POST /mcp HTTP/1.1
> Host: example.com
> Content-Type: application/json
> Accept: application/json, text/event-stream
> MCP-Protocol-Version: 2026-07-28
> Mcp-Method: tools/call
> Mcp-Name: execute_sql
> Mcp-Param-Region: us-west1
> 
> {
>   "jsonrpc": "2.0",
>   "id": 1,
>   "method": "tools/call",
>   "params": {
>     "_meta": {
>       "io.modelcontextprotocol/protocolVersion": "2026-07-28",
>       "io.modelcontextprotocol/clientInfo": {
>         "name": "ExampleClient",
>         "version": "1.0.0"
>       },
>       "io.modelcontextprotocol/clientCapabilities": {}
>     },
>     "name": "execute_sql",
>     "arguments": {
>       "region": "us-west1",
>       "query": "SELECT * FROM users"
>     }
>   }
> }
> ```
> 
> #### Value Encoding
> 
> Clients **MUST** encode parameter values before including them in HTTP
> headers to ensure safe transmission and prevent injection attacks.
> 
> **Type conversion**: Convert the parameter value to its string representation:
> 
> - `string`: Use the value as-is
> - `integer`: Convert to decimal string representation (e.g., `42`, `-7`)
> - `boolean`: Convert to lowercase `"true"` or `"false"`
> 
> Per [RFC 9110][rfc9110-values],
> HTTP header field values must consist of visible ASCII characters
> (0x21-0x7E), space (0x20), and horizontal tab (0x09). When a value cannot
> be safely represented as a plain ASCII header value (e.g., it contains
> non-ASCII characters, control characters, or has leading/trailing
> whitespace), clients **MUST** use Base64 encoding of the UTF-8
> representation with the following format:
> 
> ```text
> Mcp-Param-{Name}: =?base64?{Base64EncodedValue}?=
> ```
> 
> The same encoding rule applies to the `Mcp-Name` header value. Tool and
> prompt names are only **SHOULD**-constrained to header-safe characters, so a
> name (or resource URI) outside the safe set is carried as:
> 
> ```text
> Mcp-Name: =?base64?{Base64EncodedValue}?=
> ```
> 
> The prefix `=?base64?` and suffix `?=` indicate that the value is
> Base64-encoded. These markers are case-sensitive and **MUST** appear exactly
> as shown (lowercase). Servers and intermediaries that need to inspect these
> values **MUST** decode them accordingly. In particular, servers **MUST**
> decode an encoded `Mcp-Name` or `Mcp-Param-{Name}` value before comparing it
> to the corresponding request body value during
> [Server Validation](#server-validation).
> 
> To avoid ambiguity, clients **MUST** also Base64-encode any plain-ASCII
> value that matches the sentinel pattern (i.e., starts with `=?base64?`
> and ends with `?=`).
> 
> **Encoding examples:**
> 
> | Original Value         | Reason                   | Encoded Header Value                                  |
> | ---------------------- | ------------------------ | ----------------------------------------------------- |
> | `"us-west1"`           | Plain ASCII              | `Mcp-Param-Region: us-west1`                          |
> | `"Hello, 世界"`        | Contains non-ASCII       | `Mcp-Param-Greeting: =?base64?SGVsbG8sIOS4lueVjA==?=` |
> | `" padded "`           | Leading/trailing spaces  | `Mcp-Param-Text: =?base64?IHBhZGRlZCA=?=`             |
> | `"line1\nline2"`       | Contains newline         | `Mcp-Param-Text: =?base64?bGluZTEKbGluZTI=?=`         |
> | `"=?base64?literal?="` | Matches sentinel pattern | `Mcp-Param-Val: =?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=`  |
> 
> [rfc9110-values]: https://datatracker.ietf.org/doc/html/rfc9110#name-field-values
> 
> #### Client Behavior
> 
> When constructing a `tools/call` request via HTTP transport, the client
> **MUST**:
> 
> 1. Extract the values for any standard headers from the request body (e.g.,
>    `method`, `params.name`, `params.uri`).
> 2. Append the `Mcp-Method` header and, if applicable, `Mcp-Name` header to
>    the request.
> 3. Inspect the tool's `inputSchema` for properties marked with
>    `x-mcp-header` and extract the value at each annotated property's exact
>    property path, omitting the header when no value is present (see
>    [Schema Extension](#schema-extension)).
> 4. Encode the values according to the [Value Encoding](#value-encoding)
>    rules.
> 5. Append a `Mcp-Param-{Name}: {Value}` header to the request.
> 
> If the server rejects a request with a
> [`HeaderMismatch`](#server-validation) error because required
> `Mcp-Param-*` headers are missing or do not match the body, the client
> **SHOULD** call `tools/list` to check for changes to the tool's
> `inputSchema`, then retry the original request with the appropriate
> headers.
> 
> #### Server Behavior for Custom Headers
> 
> Intermediate servers that do not recognize an `Mcp-Param-{Name}` header
> **MUST** forward it and otherwise ignore it, as required by the
> [HTTP Semantics RFC][http-semantics].
> 
> Servers **MUST** reject requests with a recognized `Mcp-Param-{Name}` header
> that contains invalid characters (see [Value Encoding](#value-encoding)).
> 
> Any server that processes the message body **MUST** validate that encoded
> header values, after decoding if Base64-encoded, match the corresponding
> values in the request body. Servers **MUST** reject requests with a
> `400 Bad Request` HTTP status and JSON-RPC error code `-32020`
> (`HeaderMismatch`) if any validation fails.
> 
> | Scenario                                 | Client Behavior                | Server Behavior                          |
> | ---------------------------------------- | ------------------------------ | ---------------

<a id="evidence-60"></a>

### 60. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 24000–29600

> requests where the
> values specified in the headers do not match the corresponding values in the
> request body. This prevents potential security vulnerabilities when
> different components in the network rely on different sources of truth
> (e.g., a load balancer routing on the header value while the MCP server
> executes based on the body value).
> 
> <Note>
> 
> When validating integer parameter values, servers **SHOULD** compare the
> header value and the body value numerically rather than as strings (e.g.,
> `42.0` and `42` are considered equal).
> 
> </Note>
> 
> When rejecting a request due to header validation failure, servers **MUST**
> return HTTP status `400 Bad Request` and **MUST** include a JSON-RPC error
> response using the following error code:
> 
> | Code     | Name                                                                     | Description                                                                                                            |
> | -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
> | `-32020` | [`HeaderMismatch`](/specification/2026-07-28/schema#headermismatcherror) | The HTTP headers do not match the corresponding values in the request body, or required headers are missing/malformed. |
> 
> This error code is allocated from the sub-range the MCP specification
> reserves for protocol-defined errors. See
> [Error Codes](/specification/2026-07-28/basic/index#error-codes).
> 
> **Example error response:**
> 
> ```json
> {
>   "jsonrpc": "2.0",
>   "id": 1,
>   "error": {
>     "code": -32020,
>     "message": "Header mismatch: Mcp-Name header value 'foo' does not match body value 'bar'"
>   }
> }
> ```
> 
> Validation failure conditions include:
> 
> - A required standard header (`MCP-Protocol-Version`, `Mcp-Method`,
>   `Mcp-Name`) is missing.
> - A header value does not match the corresponding request body value.
>   For headers that permit the Base64 sentinel encoding (`Mcp-Name` and
>   `Mcp-Param-{Name}`), servers **MUST** decode encoded values (see
>   [Value Encoding](#value-encoding)) before comparing them to the body value.
> - A header value contains invalid characters.
> 
> <Note>
> 
> Intermediaries **MUST** return an appropriate HTTP error status (e.g.,
> `400 Bad Request`) for validation failures but are not required to return
> a JSON-RPC error response.
> 
> </Note>
> 
> <Note>
> 
> Intermediaries that enforce policy based on mirrored headers (e.g., routing
> or rate-limiting by tenant) **SHOULD** verify that the `MCP-Protocol-Version`
> header indicates a version that requires header–body validation. If the
> version is older or the header is absent, the intermediary **SHOULD** reject
> the request rather than trusting unvalidated header values.
> 
> </Note>
> 
> ## Backward Compatibility
> 
> A client that supports both modern (per-request-metadata) MCP versions and a
> legacy version that requires an `initialize` handshake **MAY** detect which
> era the server implements by attempting a modern request first. On
> `400 Bad Request`, the client **SHOULD** inspect the response body before
> falling back: modern servers also use `400` for
> [`UnsupportedProtocolVersionError`][unsupported-version],
> `MissingRequiredClientCapabilityError`, and header-validation failures.
> 
> - If the body contains a recognized modern JSON-RPC error, the server speaks
>   a modern version of MCP — retry using the advertised `supported` versions
>   or correct the request, rather than falling back.
> - If the body is empty or is not a recognized modern JSON-RPC error, fall
>   back to `initialize` and continue with the legacy version for subsequent
>   requests.
> 
> See [Versioning: Backward Compatibility][lifecycle-compat] for the era model
> and a compatibility matrix for implementors.
> 
> ### Earlier Streamable HTTP Revisions
> 
> Protocol versions `2025-03-26` through [`2025-11-25`](/specification/2025-11-25/basic/transports)
> also used the Streamable HTTP transport, but in a different shape: servers could assign a session via
> the `Mcp-Session-Id` header (terminated with HTTP DELETE), clients could open
> a standalone SSE stream with HTTP GET to receive server-initiated messages,
> servers could send JSON-RPC _requests_ on SSE streams, and streams were
> resumable via `Last-Event-ID`. None of these mechanisms are part of this
> revision.
> 
> A server that supports only this revision and receives such traffic from an
> older client **SHOULD** respond as follows:
> 
> - HTTP GET or DELETE to the MCP endpoint: respond with
>   `405 Method Not Allowed`.
> - An `Mcp-Session-Id` header on a request: ignore it, and do not mint or echo
>   session IDs.
> - A `Last-Event-ID` header: ignore it; streams are not resumable.
> 
> Servers and clients that need to interoperate with counterparts speaking
> those protocol versions implement the behavior described in the corresponding
> revision (for example,
> [2025-11-25: Streamable HTTP](/specification/2025-11-25/basic/transports#streamable-http)),
> in addition to the version-negotiation fallback described above.
> 
> ### HTTP+SSE Transport (2024-11-05)
> 
> <Warning>
>   **Deprecated**: The [HTTP+SSE transport][http-sse] from protocol version
>   2024-11-05 has been deprecated since protocol version `2025-03-26` and is
>   classified as Deprecated under the [feature lifecycle
>   policy](/community/feature-lifecycle#deprecating-a-feature)
>   ([SEP-2596](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2596)).
>   New implementations **SHOULD NOT** adopt it; existing implementations
>   **SHOULD** migrate to [Streamable
>   HTTP](/specification/2026-07-28/basic/transports/streamabl

<a id="evidence-61"></a>

### 61. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 16508–17395

> property path of the annotated property (the chain of `properties` keys
> leading to it). If no value is present at that path in the call arguments,
> the header is omitted.
> 
> Clients using the Streamable HTTP transport **MUST** reject tool definitions
> where any `x-mcp-header` value violates these constraints. Rejection means
> the client **MUST** exclude the invalid tool from the result of `tools/list`.
> Clients **SHOULD** log a warning when rejecting a tool definition, including
> the tool name and the reason for rejection. This ensures that a single
> malformed tool definition does not prevent other valid tools from being used.
> Clients using other transports (e.g., stdio) **MAY** ignore `x-mcp-header`
> annotations entirely.
> 
> **Example tool definition:**
> 
> ```json
> {
>   "name": "execute_sql",
>   "description": "Execute SQL on Google Cloud Spanner",
>   "inputSchema": {
>     "type": "object",

<a id="evidence-62"></a>

### 62. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 29504–30376

> **SHOULD** migrate to [Streamable
>   HTTP](/specification/2026-07-28/basic/transports/streamable-http). It is
>   eligible for removal in a future revision; see the [deprecated features
>   registry](/specification/2026-07-28/deprecated).
> </Warning>
> 
> Clients and servers can maintain backward compatibility with the
> deprecated [HTTP+SSE transport][http-sse] (from
> protocol version 2024-11-05) as follows:
> 
> **Servers** wanting to support older clients should:
> 
> - Continue to host both the SSE and POST endpoints of the old transport,
>   alongside the new "MCP endpoint" defined for the Streamable HTTP transport.
>   - It is also possible to combine the old POST endpoint and the new MCP
>     endpoint, but this may introduce unneeded complexity.
> 
> **Clients** wanting to support older servers should:
> 
> 1. Accept an MCP server URL from the user, which may point to either a server

<a id="evidence-63"></a>

### 63. stdio

https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-03-26/basic/transports.mdx · retrieved 2026-11-22 · text offsets 12176–13017

> new "MCP endpoint" defined for the Streamable HTTP transport.
>   - It is also possible to combine the old POST endpoint and the new MCP endpoint, but
>     this may introduce unneeded complexity.
> 
> **Clients** wanting to support older servers should:
> 
> 1. Accept an MCP server URL from the user, which may point to either a server using the
>    old transport or the new transport.
> 2. Attempt to POST an `InitializeRequest` to the server URL, with an `Accept` header as
>    defined above:
>    - If it succeeds, the client can assume this is a server supporting the new Streamable
>      HTTP transport.
>    - If it fails with an HTTP 4xx status code (e.g., 405 Method Not Allowed or 404 Not
>      Found):
>      - Issue a GET request to the server URL, expecting that this will open an SSE stream
>        and return an `endpoint` event as the first event.

<a id="evidence-64"></a>

### 64. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 30376–31258

> using the old transport or the new transport.
> 2. Attempt to POST a request to the server URL, with an `Accept` header as
>    defined above:
>    - If it succeeds, the client can assume this is a server supporting the
>      new Streamable HTTP transport.
>    - If it fails with HTTP status code `400 Bad Request`, `404 Not Found`,
>      or `405 Method Not Allowed` **and** the response body is not a
>      recognized modern JSON-RPC error (a modern server returns one for
>      unsupported version, unknown method, or header-validation failure):
>      - Issue a GET request to the server URL, expecting that this will open
>        an SSE stream and return an `endpoint` event as the first event.
>      - When the `endpoint` event arrives, the client can assume this is a
>        server running the old HTTP+SSE transport, and should use that
>        transport for all subsequent communication.

<a id="evidence-65"></a>

### 65. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 11275–12124

> not to support), it **MUST** respond with `400 Bad Request` and an
> [`UnsupportedProtocolVersionError`][unsupported-version]
> listing its supported versions. See
> [Versioning: Protocol Version Negotiation][lifecycle-version]
> for the negotiation flow.
> 
> If the server does not implement the requested RPC method, it **MUST** respond
> with `404 Not Found` and a JSON-RPC error with code `-32601`
> (`Method not found`). The JSON-RPC error body distinguishes this case from a
> `404` returned by a legacy [HTTP+SSE][http-sse] server that does not host the
> modern MCP endpoint (see [Backward Compatibility](#backward-compatibility)).
> 
> A server that supports clients implementing protocol versions earlier than
> `2025-06-18` (which did not define the `MCP-Protocol-Version` header) **MAY**
> treat a request that omits the header as protocol version `2025-03-26`. A

<a id="evidence-66"></a>

### 66. Protocol versions - MCP PHP SDK

https://php.sdk.modelcontextprotocol.io/protocol-versions/ · retrieved 2026-11-22 · text offsets 6841–7732

> com/mcp'));  $client->getProtocolVersion(); // 2026-07-28, or 2025-11-25 against an older server $client->callTool('greet', []);`
> 
> ### How the client settles on an era
> 
> `connect()` probes with `server/discover`, stamped with the preferred revision, before anything else — as the specification's backward-compatibility rules for [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#backward-compatibility) and [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility) describe.
> 
> The probe gets
> 
> The client
> 
> a `DiscoverResult` listing a modern revision it speaks
> 
> stays modern, on that revision
> 
> `-32022` naming a modern revision it speaks
> 
> retries the probe with that revision
> 
> `-32022` naming only handshake revisions
> 
> falls back to `initialize`
> 
> `-32022` naming nothing it speaks

<a id="evidence-67"></a>

### 67. modelcontextprotocol/modelcontextprotocol - docs/specification/2026-07-28/basic/transports/streamable-http.mdx

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx · retrieved 2026-11-22 · text offsets 27783–28628

> ### Earlier Streamable HTTP Revisions
> 
> Protocol versions `2025-03-26` through [`2025-11-25`](/specification/2025-11-25/basic/transports)
> also used the Streamable HTTP transport, but in a different shape: servers could assign a session via
> the `Mcp-Session-Id` header (terminated with HTTP DELETE), clients could open
> a standalone SSE stream with HTTP GET to receive server-initiated messages,
> servers could send JSON-RPC _requests_ on SSE streams, and streams were
> resumable via `Last-Event-ID`. None of these mechanisms are part of this
> revision.
> 
> A server that supports only this revision and receives such traffic from an
> older client **SHOULD** respond as follows:
> 
> - HTTP GET or DELETE to the MCP endpoint: respond with
>   `405 Method Not Allowed`.
> - An `Mcp-Session-Id` header on a request: ignore it, and do not mint or echo
>   session IDs.

<a id="evidence-68"></a>

### 68. Protocol versions - MCP PHP SDK

https://php.sdk.modelcontextprotocol.io/protocol-versions/ · retrieved 2026-11-22 · text offsets 2577–3461

> The identifiers happen to be ISO dates today, but they are an enumerated set rather than an ordered scalar, so nothing should assume they sort chronologically.
> 
> ### How the server answers
> 
> Client requests
> 
> Server responds with
> 
> A revision the server supports
> 
> That same revision
> 
> An unknown revision string
> 
> `ProtocolVersion::latestHandshake()` as a counter-offer
> 
> A missing or non-string revision
> 
> A `-32602` error
> 
> A modern revision such as `2026-07-28`
> 
> `ProtocolVersion::latestHandshake()` as a counter-offer
> 
> A counter-offer is not an error: the client decides whether it can continue on the offered revision or must close the connection. With a session, the SDK stores the negotiated revision on it under `protocol_version`. Without one, each request's `MCP-Protocol-Version` header names the revision, see [Serving without sessions](../run/sessions/#serving-without-sessions).

<a id="evidence-69"></a>

### 69. Deploying a Remote MCP Server: Stateless, Streamable HTTP, and Horizontal Scaling

https://agentscamp.com/guides/mcp/deploy-remote-mcp-server · retrieved 2026-11-22 · text offsets 5745–6644

> Take your working stdio server, expose it over **Streamable HTTP** at one endpoint, design every request to be **stateless**, put **OAuth 2.1** and input validation in front of it, and run **multiple replicas behind a load balancer** with rate limits and tracing. The protocol negotiation and tool dispatch are unchanged from the local server — what you're really doing is operating a secured, scalable API that happens to speak MCP.
> 
> For the build-and-harden work, the [mcp-server-engineer](/agents/developer-tools/mcp-server-engineer) owns exactly this transition; frameworks like [FastMCP](/tools/fastmcp) handle much of the Streamable HTTP, session, and auth plumbing for you; and once you're running more than a handful of servers, [governing them](/guides/mcp/govern-mcp-servers) — registries, [gateways](/guides/comparisons/best-mcp-gateways-2026), and tool sprawl — becomes the next problem.
