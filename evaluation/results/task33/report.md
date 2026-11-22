# 先进制程金属薄膜沉积的设备选择：PVD、CVD、ALD 为主，电子束蒸发与 MBE 未见量产证据

## 直接结论

在所列五类设备中，**先进逻辑制程的量产金属薄膜几乎完全由 PVD（物理气相沉积）、CVD（化学气相沉积，含 PECVD 与 LPCVD）和 ALD（原子层沉积）三类承担**；**电子束蒸发在证据库中只出现于研发/计量型实验室环境**；**分子束外延（MBE）在本次检索到的任何来源中均没有任何金属薄膜应用的记载**。

- **PVD**：Al、反应溅射 TiN、Ti、Ta/TaN 阻挡层与 Cu 籽晶层，以及面向高深宽比结构的 HIPIMS Ti/Ta/Cu。
- **CVD/PECVD**：WF₆ 基 W（接触与插塞）、Co（双大马士革填充与选择性填通孔预填）。
- **ALD**：TiN、TaN、Ru、W、TiAlC/TaAlC 等功函数金属——即阻挡层/衬里、势垒替代、栅极填充与金属栅。
- **电子束蒸发**：仅见于 NIST 实验室的 Al/Ag/Cu 直至 Ru/Ir/W、铂族合金与纳米线接触研究。
- **MBE**：无证据。

置信度：对 PVD/CVD/ALD 的分工为**高**（多来源一致，且有工艺步骤与机理描述）；对"电子束蒸发限于研发"为**中等**（只有实验室页面这一间接证据）；对 MBE 为**低但方向明确**——只能报告"证据库中无记载"，不能据此断言产线上绝对不存在（见末节）。

---

## 一、PVD：方向性带来的"上得多、下得少"，正好用于平坦或开口处

PVD 的核心是视线沉积：原子近乎直线飞行、落地后几乎不迁移，因此深孔底部会被开口遮蔽，底部覆盖率可低至个位数百分比，且在开口拐角堆积形成悬垂（overhang）[1](#evidence-1)[2](#evidence-2)[3](#evidence-3)。Chenming Hu 的教材同样指出溅射是方向性的，在孔壁与台阶侧壁无法得到均匀膜厚，这就是台阶覆盖问题 [4](#evidence-4)。

**沉积什么：**

- **Al 及其合金**：溅射是沉积 Al 的主要方法 [4](#evidence-4)；经典流程中"溅射 Al 铺满整片 wafer，再光刻图形化" [5](#evidence-5)。
- **TiN**：在含氮等离子体中溅射 Ti 即得 TiN [4](#evidence-4)——这是反应溅射，PVD 平台即可完成。
- **Ti、Ta/TaN、Cu 籽晶**：Cu 互连的做法是先溅射一层薄籽晶到阻挡金属（如 Ta-Cu 或 Ti-Cu）上，再电镀填充 [6](#evidence-6)；双大马士革的衬里与 Cu 沉积见 [7](#evidence-7)。
- **高深宽比结构的方向性强化**：当 AR > 3:1 时，必须用长距离溅射、准直器或电离化溅射来收窄角分布，才能保证通孔内连续成膜以支持后续电镀 [6](#evidence-6)[8](#evidence-8)；IPVD 于 1990 年代即为 VLSI 高深宽比的方向性沉积而引入 [8](#evidence-8)。HIPIMS（高功率脉冲磁控溅射）已在 200 mm 单片刻蚀设备上用于 TSV 的阻挡层/籽晶层，Ti、Ta、Cu 工艺在沉积速率、电阻率、均匀性与应力上做了优化，Ti 的离子化度可测到 46% [9](#evidence-9)[10](#evidence-10)[11](#evidence-11)[12](#evidence-12)。

**为什么选它：** 一是**速度快、工艺成熟、可大面积均匀**；二是对平坦表面与较宽开口，方向性反而有利（不需要气体前驱体渗透）；三是在高深宽比场合可以通过"加方向性"（长距离/准直/电离 + RF 基片偏压去除悬垂并加速离子）而不是换设备类别来补救 [6](#evidence-6)[8](#evidence-8)。代价是覆盖率本质受限，因此 PVD 阻挡层在 5 nm 节点遇到厚度控制与 TaN 悬垂问题，学界转向 ALD 基 TaN（≤15 Å）加 Co 衬里，并用 PVD 腔内的后处理把 ALD 膜做到与业界 PVD TaN 相当的电阻率、密度与 Ta/N 比 [13](#evidence-13)[14](#evidence-14)。

---

## 二、CVD / PECVD：靠表面反应"绕进去"，用于填充与选择性生长

CVD 的覆盖能力来自前驱体气相扩散 + 表面反应：反应受限时气体深入结构再反应，生长近乎均匀；供给受限时开口先厚、可能封口。低压 CVD（数十至数百帕）因此保形，TEOS 氧化物与 WF₆ 基钨 CVD 是经典的保形例子 [15](#evidence-15)[3](#evidence-3)。Chenming Hu 也强调 CVD 能覆盖垂直与水平面而膜厚基本无差异 [4](#evidence-4)。

**沉积什么：**

- **W（钨）**：标准方案是"TiN 粘附层 + W 成核层 + CVD W 主体"，这三层在窄结构中占据大部分体积，是 W 填充微缩的主要难题 [16](#evidence-16)。LPCVD 的 WF₆ 基 W 被明确列为因覆盖性好而被选用的典型 [15](#evidence-15)。W 因熔点最高、抗电迁移优异而长期用于插塞，且在 HKMG-last 中作为栅极填充金属 [17](#evidence-17)。
- **Co（钴）**：PECVD Co 被评估用于双大马士革结构、作为 Cu 的互连替代，仅用 1 nm ALD TiN 衬里即可实现无孔洞填充 [18](#evidence-18)；更关键的是**选择性 CVD Co**——在 Cu 上高度选择性地沉积 Co，填充 45 nm 直径、3:1 深宽比的通孔，实现无孔洞预填 [19](#evidence-19)[14](#evidence-14)。Co 不需要高阻成核层、可在低温退火中晶粒长大并回流进高深宽比插塞，且 CVD Co 前驱体不侵蚀 Ti 衬里，从而允许阻挡层减薄 [20](#evidence-20)。

**为什么选它：** 保形性好且**填充能力强于 PVD、成本/速率优于 ALD**；更重要的是 CVD 具备**选择性**（只在金属上长、不在介质上长），这是自对准预填（via prefill）的关键。代价是热预算与膜质权衡：LPCVD 氮化硅应力高但热过程与 Ni 硅化物不兼容，因此 CESL 改用低热预算的 PECVD [21](#evidence-21)——这是"为兼容已有金属硅化物而换 CVD 子类型"的直接例证。

需注意：IMEC 的 Co 预填还用了**化学镀（ELD）**，它不属于上述五类设备 [19](#evidence-19)；这提示实际产线的金属化并不局限于干法五类。

---

## 三、ALD：自限制反应换来近 100% 保形与亚埃厚度控制，用于最薄、最深、最敏感的膜

ALD 交替进行自限制表面反应，每周期最多约一个单层，在高深宽比结构中接近 100% 覆盖；CVD 次之，溅射/蒸发这类视线法最差 [2](#evidence-2)[3](#evidence-3)。ALD 可在 10:1、20:1 甚至更高深宽比上得到无针孔膜，而 PVD 受限于视线沉积；其厚度由循环数决定，可做到亚埃级 [22](#evidence-22)。GAA 器件的高k/金属栅要求原子级精度，ALD 正好提供 HfO₂ 与 TiN 的厚度控制 [23](#evidence-23)。

**沉积什么：**

- **TiN**：作为 1 nm 级衬里使 PECVD Co 无孔洞填充 10 nm 级双大马士革结构 [18](#evidence-18)；作为 Ru 的粘附促进层（薄至 0.25 nm 即可显著提高粘附）[24](#evidence-24)；作为 HKMG 的栅极金属之一 [23](#evidence-23)。
- **TaN**：≤15 Å 的 ALD TaN 阻挡层替代 PVD TaN/Ta 双层，克服 PVD 的遮蔽效应并扩大金属填充窗口 [13](#evidence-13)[14](#evidence-14)。
- **W**：ALD W 被广泛用于 W 沉积，并因沟槽填充特性用作 HKMG-last 的栅极填充金属；可选择性沉积，对 10 nm 以下器件所需的对准与边缘定义很重要 [17](#evidence-17)[25](#evidence-25)。前驱体（SiH₄、Si₂H₆、B₂H₆）影响相与填充：ALD 膜粗糙度明显优于 CVD，SiH₄ 更平滑但填充性不如 B₂H₆ [26](#evidence-26)[27](#evidence-27)。
- **Ru**：ALD Ru 作为**无阻挡层金属化**的候选，在 SiO₂ 上成核均匀、无生长抑制，10 nm 级线条电迁移表现优异 [24](#evidence-24)[28](#evidence-28)；配合半大马士革（先填充、再减材刻蚀）可做到无阻挡层、无需金属 CMP [28](#evidence-28)。
- **功函数金属**：NMOS 功函数金属研究涵盖 TaCy、TaCN、TiC、WC₀.₄、ErC₂（多为 PEALD）与 TiAlC、TaAlC（热 ALD），后者可把有效功函数在较宽区间内调节 [23](#evidence-23)。工具选择在此不是"PVD vs ALD"而是"PEALD vs 热 ALD"：等离子体增强便于成膜，但**无等离子体损伤的热 ALD 在某种程度上更适合金属栅** [23](#evidence-23)。

**为什么选它：** 在最小尺寸、最深结构、最薄厚度这三重约束下，唯有自限制反应能同时满足保形性、无针孔与厚度精度 [22](#evidence-22)[2](#evidence-2)；选择性也可由 ALD 实现（面积选择性 ALD 用抑制剂/自组装单分子层把生长限制在预定区域，减少图形化步骤并改善套刻）[29](#evidence-29)[30](#evidence-30)。代价是速率与产能——但本次证据库**未包含成本、产能（wafer/hour）、颗粒/缺陷对比数据**，因此"ALD 太慢/太贵"这一侧只能定性陈述，不能给出量化论证。

---

## 四、按工艺步骤的对应关系

| 步骤 | 设备 | 金属薄膜 | 选择理由 |
|---|---|---|---|
| 接触/插塞 | CVD（+PVD/ALD TiN 粘附） | W（TiN 粘附 + W 成核 + CVD W）[16](#evidence-16)[15](#evidence-15)；ALD W 亦可 [17](#evidence-17) | CVD/LPCVD 保形填充深孔 [15](#evidence-15)[3](#evidence-3) |
| 通孔预填 | 选择性 CVD Co | Co [14](#evidence-14)[19](#evidence-19) | 选择性生长实现自下而上无孔洞填充，降低通孔电阻 [14](#evidence-14)[19](#evidence-19) |
| 阻挡层/衬里 | PVD（传统）→ ALD（5 nm 以下） | PVD TaN/Ta [13](#evidence-13)；ALD TaN ≤15 Å + Co 衬里 [13](#evidence-13)[14](#evidence-14)；ALD TiN 1 nm [18](#evidence-18) | PVD 有悬垂与遮蔽，ALD 保形且可薄 [13](#evidence-13)[2](#evidence-2) |
| Cu 籽晶 + 填充 | PVD（籽晶）+ 电镀（填充） | Cu [6](#evidence-6)[7](#evidence-7) | 高深宽比需方向性溅射保证连续籽晶 [6](#evidence-6)[8](#evidence-8) |
| 互连金属替代 | PECVD / ALD | PECVD Co [18](#evidence-18)；ALD Ru [24](#evidence-24)[28](#evidence-28) | 无阻挡层化、阻挡/衬里可缩放 [28](#evidence-28)[24](#evidence-24)[20](#evidence-20) |
| 高k/金属栅 | ALD | HfO₂、TiN、TiAlC/TaAlC、W 填充 [23](#evidence-23)[17](#evidence-17) | 原子级厚度控制、近 100% 保形、低损伤热 ALD [23](#evidence-23)[22](#evidence-22) |
| 硅化物 | **证据不足** | NiSi₂ 仅作为材料被提及 [31](#evidence-31) | 未见任何来源描述硅化物金属的沉积设备与步骤 |

---

## 五、为什么形成这种分工：四个决定性变量

1. **保形性/深宽比**：PVD <10% 底部覆盖、CVD 居中、ALD 近 100% [1](#evidence-1)[3](#evidence-3)[2](#evidence-2)[22](#evidence-22)。这是最根本的分界线——凡"必须在深孔内连续且极薄"的膜（阻挡层、衬里、栅极堆叠）必然向 ALD 迁移 [13](#evidence-13)[22](#evidence-22)。
2. **方向性可控性**：对需要"底部有、开口不要过厚"的场合，PVD 可通过长距离、准直器、电离化与基片偏压调节角分布 [6](#evidence-6)[8](#evidence-8)[11](#evidence-11)；这是 PVD 在高深宽比下仍不可替代的一面。
3. **热预算与等离子体损伤**：金属已存在时（如 Ni 硅化物），后续膜必须降低热预算 → 选 PECVD 而非 LPCVD [21](#evidence-21)；栅极堆叠中为避免等离子体损伤 → 选热 ALD 而非 PEALD [23](#evidence-23)。
4. **选择性与自对准**：选择性 CVD Co 与面积选择性 ALD 都属于"用化学选择性省掉光刻/平坦化步骤"的思路 [19](#evidence-19)[29](#evidence-29)[30](#evidence-30)。

---

## 六、电子束蒸发与 MBE：证据说明它们不在先进制程金属化的主线

**电子束蒸发**在本证据库中的唯一具体记载是 NIST 材料计量实验室的两台高真空电子束蒸发系统：一台三源系统沉积从低熔点金属（Al、Ag、Cu）到难熔金属（Ru、Ir、W）的单层与多层膜；另一台双源系统用计算机控制的两轴挡板制备组合式/成分梯度样品 [32](#evidence-32)。其应用被明确描述为**研究用途**：把铂族合金沉积进亚 100 nm 特征的双大马士革图形晶圆以研究"无籽晶"Cu 互连，以及为纳米线器件做 Al、Ti、Ni 等金属接触 [33](#evidence-33)，另有组合阵列用于储氢与磁存储研究 [34](#evidence-34)。换言之，这是**实验室环境**，不是量产金属化。反过来，视线蒸发偶尔是"优点"：在 lift-off 工艺中，正是依赖视线蒸发使胶侧壁上的膜不连续 [35](#evidence-35)。

**分子束外延（MBE）**：在本次来源中，涉及先进 CMOS 的综述里"molecular beam epitaxy"与"evaporation"的出现次数均为 0 [36](#evidence-36)；ALD/原子层工艺综述中"molecular beam epitaxy"与"evaporation"同样为 0 [37](#evidence-37)；Chenming Hu 教材章节中"molecular beam"与"evaporation"为 0 [38](#evidence-38)。这些来源中"MBE"字符串的命中均为"number""most"之类的子串误匹配 [36](#evidence-36)[37](#evidence-37)[38](#evidence-38)。教材在讨论外延生长异质材料时举的例子是 SiGe/Si 与 LED、激光二极管，并未指定 MBE，也未讨论金属 [39](#evidence-39)。

**必须明确的方法学限制**：上述零命中只证明这些抓取文本中不存在相关词，**不能证明量产线上不存在电子束蒸发或 MBE 金属工艺**。本次检索未取得任何设备厂商的量产机台清单，也未取得明确声明"MBE 不用于先进节点金属化"的文献（原始检索目标中有若干来源因 403/406/404 未能获取）。因此对第 4 个研究问题的回答是"**未获证据支持其在先进节点金属化中的使用**"，而非"已被证伪"。若要闭合这一缺口，需要厂商产品线资料或明确讨论该问题的综述原文。

## 七、证据缺口小结（供后续核实）

- 硅化物金属（Ni/Ti）的沉积设备与步骤：无来源描述。
- 接触层 Ti/TiN 的 PVD 叠层在当代先进流程中的具体配置：无明确描述。
- 成本、产能、缺陷率的经济学比较：证据库未覆盖，故本文的经济性论证限于定性。
- Mo 互连、背面供电、Mn 自形成阻挡层：检索确认这些概念在所用来源中无可支持的内容（"Mn"在 CMOS 综述中计数为 0，在 ALD 综述中的命中为子串误匹配）[36](#evidence-36)[37](#evidence-37)，故未纳入。
- 电子束蒸发/MBE 的量产使用与否：见上节，属未决。

## Evidence

<a id="evidence-1"></a>

### 1. Step Coverage in Thin-Film Deposition: PVD vs. CVD vs. ALD | Semiconductor Room

https://semiconroom.com/en/term/step-coverage/ · retrieved 2026-11-22 · text offsets 3118–4008

> Answer: A. How thick the film deposited on the sidewalls and bottom of a step is compared with flat areas
> 
> [Step coverage](/en/term/step-coverage/) expresses how much film lands on the sidewalls and bottoms of trenches and holes relative to flat areas, e.g., bottom thickness ÷ top thickness as a percentage. PVD such as [sputtering](/en/term/sputtering/) scores low (below 10% at the bottom of deep holes) because atoms travel in straight lines; [CVD](/en/term/cvd/) scores higher as surface reactions wrap around features; [ALD](/en/term/ald/) reaches nearly 100%. For barriers and gate films that must be thin and uniform in tiny holes, this metric drives the choice of method.
> 
> ### [Under what condition does CVD give good step coverage (conformality)?](/en/q/deposition/deposition-016/)
> 
> 1.  ASurface-reaction-limited conditions (such as relatively low temperature and low pressure)
> 2.

<a id="evidence-2"></a>

### 2. Step Coverage in Thin-Film Deposition: PVD vs. CVD vs. ALD | Semiconductor Room

https://semiconroom.com/en/term/step-coverage/ · retrieved 2026-11-22 · text offsets 4791–5687

> ALD gives the best, typically close to 100%, because each self-limiting reaction cycle coats every exposed surface equally. CVD comes next, and line-of-sight PVD methods such as sputtering and evaporation are the worst.
> 
> ### Is step coverage the same as conformality?
> 
> They are closely related and often used interchangeably. Conformality describes how evenly a film follows topography in general, while step coverage is usually quoted as a specific thickness ratio, such as bottom-to-top or sidewall-to-top.
> 
> ### Why is step coverage poor in sputtering?
> 
> Sputtered atoms travel almost in straight lines and stick where they land, so the trench opening shadows the sidewalls and bottom. Film builds up at the top corners instead, forming overhangs.
> 
> ## Questions that mention Step coverage (6)
> 
> Step coverage appears in 8 practice questions across 1 topic, including Deposition (CVD and PVD).
> 
> 1.

<a id="evidence-3"></a>

### 3. Step Coverage in Thin-Film Deposition: PVD vs. CVD vs. ALD | Semiconductor Room

https://semiconroom.com/en/term/step-coverage/ · retrieved 2026-11-22 · text offsets 647–1422

> In physical vapor deposition (PVD), such as [sputtering](/en/term/sputtering/) or evaporation, atoms fly in nearly straight lines and barely migrate after landing, so surfaces not in line of sight from the opening are shadowed; bottom coverage in deep holes can fall below 10%. Chemical vapor deposition ([CVD](/en/term/cvd/)) delivers [precursor](/en/term/precursor/) gases that diffuse into features and react on the surface, giving much better coverage. Atomic layer deposition ([ALD](/en/term/ald/)) alternates self-limiting surface reactions, each adding at most about one monolayer per cycle, and reaches close to 100% even in very high-aspect-ratio structures.
> 
> ## Reaction-limited vs. supply-limited CVD
> 
> [CVD](/en/term/cvd/) coverage depends on which step is slower.

<a id="evidence-4"></a>

### 4. Chenming Hu ch3

https://www.chu.berkeley.edu/wp-content/uploads/2020/01/Chenming-Hu_ch3.pdf · retrieved 2026-11-22 · text offsets 36720–37513

> For example, when Ti is sputtered in a nitrogen-containing plasma, a TiN (titanium nitride) film is deposited on the Si wafer. Sputtering is the chief method of depositing Al and other metals. Sputtering is sometimes called a method of physical vapor deposition (PVD) . 3.7.2 Chemical Vapor Deposition (CVD) While sputtering is a relatively simple and satisfactory way of depositing thin film over flat surfaces, it is directional and cannot deposit uniform films on the vertical walls of holes or steps in the surface topography. This is called a step coverage problem. CVD, on the other hand, deposits a much more conformal film, which covers the vertical and horizontal surfaces with basically no difference in the film thickness. In CVD, the thin film is formed from gas-phase components.

<a id="evidence-5"></a>

### 5. Chenming Hu ch3

https://www.chu.berkeley.edu/wp-content/uploads/2020/01/Chenming-Hu_ch3.pdf · retrieved 2026-11-22 · text offsets 48811–49687

> Some oxide may be formed in the diffusion process. This must be cleaned off before step 6, metallization. Sputtering of Al deposits a thin metal film over the entire surface of the wafer as pictured in step 6. A lithography process (step 7) is then performed to pattern the metal. A low-temperature ( ≤ 450 ° C) anneal is performed to produce a low- resistance contact between the metal and Si. In step 9, SiO2 and Si3N4 films are deposited for encapsulation to protect the device from moisture and other contaminants. In step 10, an opening is made to access the Al for wire bonding. If electrical contact is to be made to the P-type substrate, the oxide grown on the back of the wafer in step 2 must be removed while the front of the wafer is protected with photoresist as shown in step 11. Gold (Au) is deposited at the back of the wafer for electrical contact in step 12.

<a id="evidence-6"></a>

### 6. PVD Processes in High Aspect Ratio Features by HIPIMS

https://www.shu.ac.uk/-/media/home/research/meri/what-we-do/projects/pvd-processes-in-high-aspect-ratio-featres-by-hipims.pdf · retrieved 2026-11-22 · text offsets 2330–3043

> Copper interconnects are deposited by sputtering a thin seed layer onto a barrier metal film (e.g., Ta-Cu or Ti-Cu) followed by electroplat- ing. While some applications are already moving to volume production, there are still many open questions, like what aspect ratio (AR) vias will be required and what materials and techniques will be able to fill them. In via structures with AR > 3:1, it is required to deposit these layers by directional sputtering techniques to ensure a continuous layer in the entire via to enable electroplating. Directional sputtering is achieved through narrowing the angular distribution by a) long distance sputtering b) collimators [6] or c) ionization of the sputtered material.

<a id="evidence-7"></a>

### 7. Chenming Hu ch3

https://www.chu.berkeley.edu/wp-content/uploads/2020/01/Chenming-Hu_ch3.pdf · retrieved 2026-11-22 · text offsets 45479–46236

> 9 TESTING, ASSEMBLY, AND QUALIFICATION After the wafer fabrication process is completed, individual ICs are electrically probed on the wafer to determine which IC chips are functional. The rest are marked and will not be packaged. FIGURE 3–23 Basic steps of forming a copper interconnect line using the damascene process: (a) cover the wafer with a dielectric such as SiO 2 ; (b) etch a trench in the dielectric; (c) deposit a liner film and then deposit Cu; and (d) polish away the excess metal by CMP. Dielectric Dielectric Dielectric Liner (a) (c) Cu Liner Dielectric (d) Cu (b) ● Planarization ● A flat surface is highly desirable in IC processing because it greatly improves sub- sequent optical lithography (the whole surface is in focus) and etching.

<a id="evidence-8"></a>

### 8. PVD Processes in High Aspect Ratio Features by HIPIMS

https://www.shu.ac.uk/-/media/home/research/meri/what-we-do/projects/pvd-processes-in-high-aspect-ratio-featres-by-hipims.pdf · retrieved 2026-11-22 · text offsets 3043–3777

> These methods are typically used in combination with a radio frequency (RF) induced self bias voltage applied on the substrate in order to remove overhanging materials from the features as well as to accelerate ionized metal to the substrate [7]. Ionized physical vapour deposition (IPVD) has been introduced in the 1990s to cope with the requirement of directional deposition in VLSI features with high AR. In most cases, the neutral metal vapour is ionized by additional excitation such as an inductive RF coil [8]. As a novel IPVD technology High Power Impulse Magne- tron Sputtering (HIPIMS) or High Power Pulsed Magnetron Sputtering (HPPMS) has been introduced by Kouznetsov [9] using very short pulses of typically less than 0.

<a id="evidence-9"></a>

### 9. PVD Processes in High Aspect Ratio Features by HIPIMS

https://www.shu.ac.uk/-/media/home/research/meri/what-we-do/projects/pvd-processes-in-high-aspect-ratio-featres-by-hipims.pdf · retrieved 2026-11-22 · text offsets 678–1494

> Ehiasarian, Materials and Engineering Research Institute, Sheffield Hallam University, Sheffield, United Kingdom ABSTRACT High Power Impulse Magnetron Sputtering (HIPIMS) has been developed on rotating PVD magnetron sources for uniform deposition on 200mm single wafer tools for barrier and seed layer deposition in through silicon vias (TSV). The ionization degree has been analyzed by atomic absorption spectroscopy. Processes and hardware have been developed for HIPIMS of Ti, Ta and Cu with reasonable deposition rates and a high transfer factor due to low target substrate distance, good uniformities and low stress for the application in deep silicon etched features with very high aspect ratio (AR). For Ti a bottom coverage of 20% in trenches with AR 10:1 and 7% in trenches with AR 30:1 have been achieved.

<a id="evidence-10"></a>

### 10. PVD Processes in High Aspect Ratio Features by HIPIMS

https://www.shu.ac.uk/-/media/home/research/meri/what-we-do/projects/pvd-processes-in-high-aspect-ratio-featres-by-hipims.pdf · retrieved 2026-11-22 · text offsets 14838–15701

> The change of the deposition profile has to be compensated by a proper design of the magnet which is principally no issue; however it should be noted that processes with different peak currents in the same chamber will require different magnet sets. Also the rate drop for HIPIMS does not mean a disqualification for TSV applications since here the deposition rate inside deep features is actually enhanced. Taking these effects into con- sideration, processes for Ti, Ta and Cu have been optimized with respect to deposition rate, specific resistivity, uniformity and film stress. The results are summarized in Table 1. The specific resistivity is slightly higher than typical bulk value due to a fine-grained microstructure of the films. Please note that α-phase Ta could be obtained with an extremely thin seed layer due to high ionization.
> 
> <!-- Page 4 -->

<a id="evidence-11"></a>

### 11. PVD Processes in High Aspect Ratio Features by HIPIMS

https://www.shu.ac.uk/-/media/home/research/meri/what-we-do/projects/pvd-processes-in-high-aspect-ratio-featres-by-hipims.pdf · retrieved 2026-11-22 · text offsets 4100–5308

> -13]. Plasma measurements indicate a peak electron density of the order of 10 19 m -3 , expanding from the target with a fixed velocity that depends on the gas pressure. The high electron density results in a high degree of ionization of the sputtered material. The ionization degree for HIPIMS near the target has been analyzed by optical emission spectroscopy and reported to be more than 90% for Ti [14]. A comparison with post-ionization by a RF coil showed that HIPIMS gen- erates a twofold higher ionization degree which is constant over the distance, whereas the ionization by RF coil can only be found at distances greater than 10cm from the target [15]. The metal ionization degree and metal ion-to-gas ion ratios in HIPIMS depend strongly on the discharge current and can be adjusted in a wide range. The average energy of metal ions is of the order of 3-6eV, however when HIPIMS is operated at low pressure of 10 -3 mbar, the high energy tail of ions can reach several 10s of eV near the substrate. The origin of the ion energy is mainly from the atoms generated during the sputtering process which are subsequently ionized in the plasma. The energy can be reduced by increasing the pressure [16].

<a id="evidence-12"></a>

### 12. PVD Processes in High Aspect Ratio Features by HIPIMS

https://www.shu.ac.uk/-/media/home/research/meri/what-we-do/projects/pvd-processes-in-high-aspect-ratio-featres-by-hipims.pdf · retrieved 2026-11-22 · text offsets 12463–13230

> RESULTS AND DISCUSSION The ionization degree was evaluated in the lab tool for a HIPIMS discharge of Ti with rotating target by AAS in a distance of 13cm from the target. The measurements were captured as function of the HIPIMS peak current at a delay time of 500μsec after the HIPIMS voltage was switched off. In Figure 1 the results of the AAS measurements are plotted showing that the absorption of Ti 1+ is steadily increasing with increasing peak current whereas the Ti 0 reaches a maximum and starts to decrease above 600A. The ionization degree calculated from these two absorption signal shows that it reaches a value of 46% at a peak current of 1000A. specific deposition rate, defined as the deposition rate divided by the average power, is being observed.

<a id="evidence-13"></a>

### 13. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 58200–59600

> hicknesses negatively affect the dielectric breakdown as well as the electromigration (EM) properties \[[144](#B144-micromachines-10-00293)\]. Hence, these issues eventually stop scalable solutions for interconnects.
> 
> Materials innovation and integration improvement are the requirements for diffusion barriers in combination with low-_k_ dielectrics, the resistance to EM, and lower resistance than the combination of Cu and barrier layers in small dimensions. According to these requirements, there are two methods to improve them. One is to partially modify traditional Cu integration process and the other is to use new materials to replace the Cu integration process.
> 
> As the critical dimension continues to shrink to a 5-nm node, the bilayer approach (PVD TaN/Ta) faces scaling challenges, e.g., thickness control and PVD TaN over-hang. Wu et al. reported a novel approach to use thin (≤ 15 Å) ALD-based TaN barriers \[[145](#B145-micromachines-10-00293)\] and Co liner instead of copper electroplating. The use of a post-ALD treatment in a PVD chamber resulted in ALD films with resistivity, density, and a Ta/N ratio similar to industry-standard PVD TaN. This approach enables the conformal Cu barrier without reliability degradation compared to PVD TaN \[[145](#B145-micromachines-10-00293)\]. This new method overcomes the shadowing effect of the traditional PVD approach and improves the m

<a id="evidence-14"></a>

### 14. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 59600–61100

> etal-fill process window. Furthermore, this method promotes lower via-resistance through barrier thickness reduction, which proves it to be a viable Cu-barrier candidate for the 5-nm node and beyond. However, this approach would only be a short-term alternative due to a size effect of Cu resistivity and TaN high resistance \[[146](#B146-micromachines-10-00293)\].
> 
> Van der Veen et al. \[[147](#B147-micromachines-10-00293)\] and Zhang et al. \[[148](#B148-micromachines-10-00293)\] introduced Co via-prefill concept to achieve void-free and bottom-up fill of metal in advanced interconnects, as shown in [Figure 20](#micromachines-10-00293-f020). The via-prefill is beneficial for the Cu damascene process. The direct contact of Co and Cu at the bottom without TaN/Ta barrier interface results in a reduction of via-resistance. Moreover, Co is expected to have a better EM performance compared to Cu due to its higher melting point \[[143](#B143-micromachines-10-00293),[146](#B146-micromachines-10-00293),[149](#B149-micromachines-10-00293),[150](#B150-micromachines-10-00293)\].
> 
> ### Figure 20.
> 
> [![Figure 20](https://cdn.ncbi.nlm.nih.gov/pmc/blobs/e642/6563067/fd93a1465359/micromachines-10-00293-g020.jpg)](https://www.ncbi.nlm.nih.gov/core/lw/2.0/html/tileshop_pmc/tileshop_pmc_inline.html?title=Click%20on%20image%20to%20zoom&p=PMC3&id=6563067_micromachines-10-00293-g020.jpg)
> 
> Integration of Co selective growth \[[148](#B148-micromachines-10-00293)\].
> 
> Zhang et al. reported, for the first

<a id="evidence-15"></a>

### 15. Step Coverage in Thin-Film Deposition: PVD vs. CVD vs. ALD | Semiconductor Room

https://semiconroom.com/en/term/step-coverage/ · retrieved 2026-11-22 · text offsets 1422–2226

> If the surface reaction is slow (reaction-limited), gas penetrates deep into the feature before it reacts, and growth rate is nearly uniform everywhere. If gas supply is slow (supply- or transport-limited), the opening receives more [precursor](/en/term/precursor/) than the bottom, so the top thickens and may close off. Lower temperature slows the reaction and lower pressure speeds gas diffusion, so [low-pressure CVD](/en/term/lpcvd/) (LPCVD) at tens to hundreds of pascals is conformal. [TEOS](/en/term/teos/) oxide and WF6-based tungsten CVD are classic examples chosen for their good coverage.
> 
> ## Where step coverage matters
> 
> Barrier and liner layers in contacts and [vias](/en/term/interconnect-via/) must be continuous yet thin, so their sidewall and bottom coverage directly sets reliability.

<a id="evidence-16"></a>

### 16. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 68253–69093

> The standard process scheme has included a TiN adhesion layer to dielectrics and a nucleation W layer for CVD W, but these layers consume most of the volume in narrow features. A major challenge for W fill scaling is that the line resistance of sheet Rs and plug resistance of contact Rc increase due to a reduction in the volume of the low resistance CVD W bulk material. Recent simulation results of the local interconnect resistance indicated that the M0 and the contact would become dominant contributors to a resistance increase at the 5-nm process node \[[155](#B155-micromachines-10-00293)\]. W M0 and Contact comprise 65% of the total M0/M1 stack resistance due to a narrow CD. Contact shows 43% reduction in M0/M1 resistance.
> 
> CVD Cobalt (Co) has been used in recent studies as replacement for W in local interconnect showing a 2.

<a id="evidence-17"></a>

### 17. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 38640–39478

> The reason for choosing NCFET is due to its dramatic improvement in a sub-threshold swing, which has compatible process flow with the conventional CMOS technology, and on-current enhancement \[[92](#B92-micromachines-10-00293)\]. The high-_k_ materials suitable for NCFET are considered to be HfZrO and HfO2 with a thickness below 5 nm.
> 
> ## 9\. Interconnections in CMOS
> 
> Tungsten (W) has excellent thermal stability, the highest melting point among all metals, and perfect resistance to electro-migration (EM). The tungsten plug has been used for metal interconnection in integrated circuits to connect different layers of metals to nano transistors. ALD has been widely used for deposition of tungsten. ALD W has been used as gate filling metal (HKMG-last) due to its properties for trench filling \[[93](#B93-micromachines-10-00293)\].

<a id="evidence-18"></a>

### 18. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 65070–65775

> Ru films were patterned using EUV single exposure and subtractive etch to generate lines with CD down to 10.5 nm. This approach has excellent process control, stability, and results in a very high line yield. These results indicate that the subtractive etch of Ru could be a viable interconnect candidate for advanced technology nodes.
> 
> Plasma enhanced chemical vapor deposition Co was evaluated to fill dual damascene (DD) structures as an interconnect wiring metal alternative to Cu \[[139](#B139-micromachines-10-00293)\]. The void-free gap fill of damascene structures down to 10 nm CD was demonstrated using just 1 nm ALD TiN liner. A CMP process without Co residues or corrosion has been developed.

<a id="evidence-19"></a>

### 19. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 61100–63000

> time, a highly selective CVD Co deposition on Cu to fill a 45 nm diameter with 3:1 aspect ratio in a Cu dual damascene structure \[[148](#B148-micromachines-10-00293)\]. The results showed void- free Co-fill of the vias. interuniversity microelectronics centre (IMEC) demonstrated the feasibility of the prefill concept using the electroless deposition (ELD) technique for Co as material to pre-fill vias \[[147](#B147-micromachines-10-00293),[151](#B151-micromachines-10-00293),[152](#B152-micromachines-10-00293)\]. The main benefit of having Co vias is the reduction of the via-resistance. As the via CD shrinks, vias with ELD-Co show larger resistance reduction compared to the conventional PVD-EC Dones. As an example, at 40 nm via critical dimension (CD), the via-resistance reduction is ~30% \[[151](#B151-micromachines-10-00293)\]. For 12 nm chamfered vias with 3 nm metal barrier and Co via prefill, 45% resistance reduction can be achieved \[[152](#B152-micromachines-10-00293)\]. Therefore, the selective Co process for contact and via prefill has the potential to enable future scaling of the advanced technology node.
> 
> Marleen et al. benchmarked Ru, Co, and Cu in a damascene vehicle with scaled dimensions down to 11 nm CD and for different aspect ratios \[[142](#B142-micromachines-10-00293)\]. The Ru and Co NWs have higher resistivity, but Ru and Co are both superior to Cu for trenches smaller than 250 nm2. The difference in resistance for the Ru, Co, and Cu is clearly increased with the decrease of the total wire area, as illustrated in [Figure 21](#micromachines-10-00293-f021) \[[142](#B142-micromachines-10-00293)\]. The slope for Cu increases and it crosses over to Co and Ru at 400 nm2. Ru effective resistance potentially crosses the Cu curve at 14 nm by assuming that the Cu barrier/liner thickness was 2 nm. The cross-point would happen at 8 nm with 1 nm Cu barrier/line

<a id="evidence-20"></a>

### 20. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 69093–69900

> 5× line resistance reduction, void-free and seamless fill at the local interconnect level \[[156](#B156-micromachines-10-00293)\]. Unlike W, Co metal does not need high resistivity nucleation layers and can be annealed at low temperature to undergo grain growth and reflow into the high aspect ratio contact plug. Moreover, CVD Co precursors do not attack Ti liner, which enables barrier thickness scaling. The resistivity of Ru \[[157](#B157-micromachines-10-00293)\] is comparable to that of Co in terms of 7 nm MOL critical dimensions. Both Ru and Co have better liner/barrier scalability compared to W. Susan Su-Chen Fanet al. demonstrated Ru metallization assessment on 7 nm MOL with remarkable resistance reduction in the S/D contact and MOL local interconnect \[[158](#B158-micromachines-10-00293)\].

<a id="evidence-21"></a>

### 21. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 46000–47200

> leshop_pmc/tileshop_pmc_inline.html?title=Click%20on%20image%20to%20zoom&p=PMC3&id=6563067_micromachines-10-00293-g016.jpg)
> 
> (**a**) Electron effective mobility in NFET and (**b**) TEM images Ω-Gate CMOS NW transistors for N-FET \[[108](#B108-micromachines-10-00293)\].
> 
> ### 10.1. High Tensile Stress CESL
> 
> Many growth techniques have been applied to deposit high tensile SiNx, e.g., LPCVD (low pressure chemical vapor deposition), ALD, and PECVD (plasma enhanced chemical vapor deposition). It is known that Si3N4 films produced by the LPCVD technique possess high tensile stress of 2 Gpa. However, the relatively high thermal process makes the process not compatible with Ni silicide \[[109](#B109-micromachines-10-00293)\]. Therefore, PECVD technology with a low thermal budget process was taken as the best choice to deposit CESL \[[110](#B110-micromachines-10-00293)\].
> 
> Unfortunately, the hydrogen in PECVD nitride film could not have been pushed out, which pulled down the film tensile stress to about 1 Gpa \[[111](#B111-micromachines-10-00293)\]. There are various reports that demonstrate methods. Plasma treatment and the ultraviolet thermal process (UVTP) can enhance the tensile stress.

<a id="evidence-22"></a>

### 22. Novel Atomic Layer Processes for Semiconductor Manufacturing: Area Selective Deposition, Atomic Layer Annealing, and Atomic Layer Etching

https://link.springer.com/article/10.1007/s12541-025-01337-z · retrieved 2026-11-22 · text offsets 13215–14047

> This permits sub-Å control of film thickness by simply adjusting the number of cycles, far exceeding the precision of conventional CVD or PVD techniques.
>     
> *   Extreme conformality: ALD achieves uniform coating over all exposed surfaces, even deep within trenches or around complex 3D structures. Because the gas-phase precursors diffuse into recessed features and react in a layer-by-layer manner, ALD can produce pinhole-free films on structures with aspect ratios of 10:1, 20:1, or higher. In contrast, PVD is limited by line-of-sight deposition.
>     
> *   Material and temperature versatility: A wide range of chemistries is available for ALD. Commonly deposited materials include oxides (Al2O3, HfO2, SiO2), nitrides (TiN, AlN), sulfides, metals (Ru, Pt, W, etc.), and even complex materials such as doped oxides and alloys.

<a id="evidence-23"></a>

### 23. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 35200–38600

> 2 nm, respectively.
> 
> For transistors beyond the 5-nm node, the device performance cannot be further improved by optimizing gate stacks. The high-_k_ dielectric and metal-gate are simply very thin and cannot be further decreased. For the GAA device structure, the deposition of HKMG requires precision in atomic levels. The ALD technique offers a good control for layer thickness of HfO2 and TiN. However, for NMOSFET, it is relatively difficult to acquire the N-type work function metal due to the precursor limitation. In this field, TaCy \[[82](#B82-micromachines-10-00293)\], TaCN \[[83](#B83-micromachines-10-00293)\], TiC \[[84](#B84-micromachines-10-00293)\], WC0.4 \[[85](#B85-micromachines-10-00293)\], and ErC2 \[[86](#B86-micromachines-10-00293)\] were studied for NMOSFET application. However, in most of these processes, plasma enhanced ALD (or PEALD) was used. To some extent, thermal ALD without plasma damage is more suitable for the metal gate. TiAlX films as the metal gate were developed by Chao et al. by the thermal ALD technique using TiCl4, TMA (Al(CH3)3), and NH3. It was demonstrated that NH3 presence in the TiCl4 and TMA reaction makes the film more like TiAlN(C) while its absence makes the film turn to TiAlC. The TiAlC film has a smaller effective work function than the TiAlN(C) film \[[87](#B87-micromachines-10-00293)\]. The effective work function can be tailored from 4.49 eV to 4.79 eV by tuning the process conditions \[[88](#B88-micromachines-10-00293)\]. By introducing the triethylaluminum (TEA) into the process, more Al-doping is obtained in the TiAlC film due the reaction of TEA with TiCl4. The effective work function of the TiAlC with TEA as a precursor can be tunable from 4.46 eV to 4.24 eV \[[89](#B89-micromachines-10-00293)\]. The deposition of TaAlC films using TMA and TEA has almost the same effective work function as TiAlC films grown by TMA and TEA separately, which provide more choices for metal gate selection \[[90](#B90-micromachines-10-00293),[91](#B91-micromachines-10-00293)\]. The effective work function of different metals for NMOSFET are summarized in [Table 2](#micromachines-10-00293-t002) \[[82](#B82-micromachines-10-00293),[83](#B83-micromachines-10-00293),[84](#B84-micromachines-10-00293),[85](#B85-micromachines-10-00293),[86](#B86-micromachines-10-00293),[87](#B87-micromachines-10-00293),[88](#B88-micromachines-10-00293),[89](#B89-micromachines-10-00293),[90](#B90-micromachines-10-00293),[91](#B91-micromachines-10-00293)\].
> 
> ### Table 2.
> 
> The effective work function of different metals grown by ALD for NMOSFET.
> 
> Metal
> 
> Dep. Method
> 
> Effective Work Function
> 
> Ref.
> 
> TaCy
> 
> PEALD
> 
> 4.77–4.54 eV
> 
> \[[84](#B84-micromachines-10-00293)\]
> 
> TaCN
> 
> PEALD
> 
> 4.37 eV
> 
> \[[85](#B85-micromachines-10-00293)\]
> 
> TiC
> 
> PEALD
> 
> 5.24 eV–4.45 eV
> 
> \[[86](#B86-micromachines-10-00293)\]
> 
> WC0.4
> 
> PEALD
> 
> 4.2+/-0.1 eV
> 
> \[[87](#B87-micromachines-10-00293)\]
> 
> ErC2
> 
> ALD
> 
> 3.9 eV
> 
> \[[88](#B88-micromachines-10-00293)\]
> 
> TiAlC
> 
> thermal ALD
> 
> 4.79–4.49
> 
> \[[90](#B90-micromachines-10-00293)\]
> 
> TiAlC
> 
> thermal ALD
> 
> 4.46–4.24
> 
> \[[91](#B91-micromachines-10-00293)\]
> 
> TaAlC
> 
> thermal ALD
> 
> 4.74–4.49
> 
> \[[92](#B92-micromachines-10-00293)\]
> 
> TaAlC
> 
> thermal ALD
> 
> 4.65–4.26
> 
> \[[93](#B93-micromachines-10-00293)\]
> 
> High-_k_ material can be applied for a more complicated transistor design, e.g., negative capacitance FET (NCFET). This type of transistor is a strong pot

<a id="evidence-24"></a>

### 24. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 63359–64178

> gov/pmc/blobs/e642/6563067/806f387d3ec8/micromachines-10-00293-g021.jpg)](https://www.ncbi.nlm.nih.gov/core/lw/2.0/html/tileshop_pmc/tileshop_pmc_inline.html?title=Click%20on%20image%20to%20zoom&p=PMC3&id=6563067_micromachines-10-00293-g021.jpg)
> 
> Damascence line resistance vs. the total conductor area of Ru, Co, and Cu NWs \[[142](#B142-micromachines-10-00293)\].
> 
> ALD Ru was studied as an option for barrier-less metallization for the future interconnects \[[141](#B141-micromachines-10-00293)\]. Ru shows regular nucleation on SiO2 without any growth inhibition. The adhesion was significantly increased to 7.0 ± 2.3 J/m2 by applying an ALD TiN adhesion promoting layer with a thickness as low as 0.25 nm. The Ru lines with widths of about 10 nm, which show excellent EM behavior on a single damascene test vehicle.

<a id="evidence-25"></a>

### 25. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 39400–40500

> ue to its properties for trench filling \[[93](#B93-micromachines-10-00293)\]. ALD W can be selectively deposited and this is important for advanced sub-10 nanometer transistors, which needs good alignment to underlying structures, and edge definition \[[94](#B94-micromachines-10-00293)\]. W films have an α-phase and a β-phase with different morphologies and electrical properties. W films with an α-phase have the lowest resistivity and an important role in the logic MOSFETs.
> 
> The common precursors used for ALD W are SiH4 \[[95](#B95-micromachines-10-00293),[96](#B96-micromachines-10-00293),[97](#B97-micromachines-10-00293),[98](#B98-micromachines-10-00293),[99](#B99-micromachines-10-00293),[100](#B100-micromachines-10-00293),[101](#B101-micromachines-10-00293),[102](#B102-micromachines-10-00293),[103](#B103-micromachines-10-00293),[104](#B104-micromachines-10-00293),[105](#B105-micromachines-10-00293),[106](#B106-micromachines-10-00293),[107](#B107-micromachines-10-00293),[108](#B108-micromachines-10-00293)\], Si2H6 \[[99](#B99-micromachines-10-00293)\], and B2H6 \[[100](#B100-microm

<a id="evidence-26"></a>

### 26. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 40500–42500

> achines-10-00293),[101](#B101-micromachines-10-00293),[102](#B102-micromachines-10-00293),[103](#B103-micromachines-10-00293)\]. Different precursors will form films with different phases. Qiang Xu et al. studied the adhesion, roughness, and pore filling ability of ALD W films using different growth methods and different precursors for the 22-nm technology node, as shown in [Figure 14](#micromachines-10-00293-f014) \[[104](#B104-micromachines-10-00293)\]. The authors demonstrated that the roughness of the W film grown by the ALD technique is clearly better than that of CVD. The roughness of ALD films grown by SiH4 is better than that of the B2H6 precursors. However, the filling performance of SiH4 is worse than that of B2H6.
> 
> ### Figure 14.
> 
> [![Figure 14](https://cdn.ncbi.nlm.nih.gov/pmc/blobs/e642/6563067/44f720e32afb/micromachines-10-00293-g014.jpg)](https://www.ncbi.nlm.nih.gov/core/lw/2.0/html/tileshop_pmc/tileshop_pmc_inline.html?title=Click%20on%20image%20to%20zoom&p=PMC3&id=6563067_micromachines-10-00293-g014.jpg)
> 
> Cross-sectional SEM images of W films grown in different conditions: (**a**) on blank wafers and (**b**) trenches filling capacity \[[104](#B104-micromachines-10-00293)\].
> 
> In order to further understand the internal morphology of the ALD W film, Wang et al. measured the morphology of these films by using the XRD technique. It was found that there were two kinds of crystalline phases in the ALD W films grown by SiH4 as precursors, while the films grown with B2H6 were amorphous, as shown in [Figure 15](#micromachines-10-00293-f015) \[[98](#B98-micromachines-10-00293)\].
> 
> ### Figure 15.
> 
> [![Figure 15](https://cdn.ncbi.nlm.nih.gov/pmc/blobs/e642/6563067/3bc2b8c59a4e/micromachines-10-00293-g015.jpg)](https://www.ncbi.nlm.nih.gov/core/lw/2.0/html/tileshop_pmc/tileshop_pmc_inline.html?title=Click%20on%20image%20to%20zoom&p=PMC3&id=6563067_micromachines-10-00293-g015.jpg)
> 
> XRD spectra of ALD W using SiH4 and B2H6 and calculated stress data on a blank subs

<a id="evidence-27"></a>

### 27. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 43302–44151

> For example, in the study of selective ALD deposition, it was found that hydroxyl bonds were formed on the surface of SiO2 after wet cleaning, which resulted in the nucleation of SiH4 and WF6 on the surface of SiO2 \[[94](#B94-micromachines-10-00293)\]. However, the nucleation is greatly delayed after the removal of surface hydroxyl groups by heating or using a precursor, which interact with the surface to change the surface characteristics. For example, when B2H6 and WF6 are used as precursors, pretreatment with B2H6 accelerates nucleation. At the same time, the resistivity of the film is reduced.
> 
> F.H. Fabreguette presented the Quartz crystal microbalance study of the tungsten atomic layer deposition using WF6 and Si2H6. This work found that the growth rate of ALD W was weakly temperature-dependent with an activation energy of 1.5 ±0.

<a id="evidence-28"></a>

### 28. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 64178–65070

> Time-dependent dielectric breakdown measurements revealed negligible Ru ion drift into dense low-k dielectrics with k ∼3.0 up to 200 °C, which demonstrates that Ru has the potential to be used as a barrierless metallization as a future advanced interconnect solution.
> 
> Currently, the damascene implementation of Ru lines is hampered by the availability of optimized CMP. A semi-damascene integration approach is a proposed solution for the multi-level Ru interconnect \[[153](#B153-micromachines-10-00293)\]. This method is formed in low-k and then followed by filling both the via and the trench layers with a single deposition step. Key advantages are that the process can be barrier-less, the grain size can be tuned, and there is no requirement for metal CMP. The trench layer is then patterned using subtractive etch, which eliminates the need for plasma processing of low-_k_ trenches.

<a id="evidence-29"></a>

### 29. Novel Atomic Layer Processes for Semiconductor Manufacturing: Area Selective Deposition, Atomic Layer Annealing, and Atomic Layer Etching

https://link.springer.com/article/10.1007/s12541-025-01337-z · retrieved 2026-11-22 · text offsets 18215–19079

> *   ASD modifies ALD chemistries or introduces surface inhibitors to confine film growth exclusively to predefined regions. This considerably reduces the number of patterning steps and improves overlay accuracy in HAR architectures. Given the increasing demand for higher integration densities and more complex device designs, ASD plays a crucial role in overcoming the limitations of conventional patterning techniques in advanced semiconductor fabrication \[[28](#ref-CR28 "Fang, M., & Ho, J. C. (2015). Area-selective atomic layer deposition: Conformal coating, subnanometer thickness control, and smart positioning. ACS Nano, 9(9), 8651–8654."),[29](#ref-CR29 "Parsons, G. N. (2019). Functional model for analysis of ALD nucleation and quantification of area-selective deposition. Journal of Vacuum Science & Technology A, 37(2), 020911. 
>     https://pubs.aip.

<a id="evidence-30"></a>

### 30. Novel Atomic Layer Processes for Semiconductor Manufacturing: Area Selective Deposition, Atomic Layer Annealing, and Atomic Layer Etching

https://link.springer.com/article/10.1007/s12541-025-01337-z · retrieved 2026-11-22 · text offsets 33130–33930

> These inhibition layers typically remain stable for a specific number of ALD cycles (known as the “selectivity window”), but may eventually degrade or detach, resulting in reduced selectivity.
> 
> A classic example of this strategy is the use of SAMs applied before the ALD precursor pulse. Bobb-Semple et al. \[[50](/article/10.1007/s12541-025-01337-z#ref-CR50 "Bobb-Semple, D., Nardi, K. L., Draeger, N., Hausmann, D. M., & Bent, S. F. (2019). Area-selective atomic layer deposition assisted by self-assembled monolayers: a comparison of Cu, Co, W, and Ru. Chemistry of Materials, 31(5), 1635–1645.")\] demonstrated that alkyl-terminated SAMs, such as octadecylphos phonic acid (ODPA), effectively inhibit metal precursor adsorption on various metal surfaces, thereby enabling AS-ALD of ZnO or Al2O3.

<a id="evidence-31"></a>

### 31. Chenming Hu ch3

https://www.chu.berkeley.edu/wp-content/uploads/2020/01/Chenming-Hu_ch3.pdf · retrieved 2026-11-22 · text offsets 42975–43871

> The adjacent layers of metal are separated by intermetal dielectric layers. Electrical connection between the adjacent metal layers is made through a via . To reduce the contact resistance (see Section 4.21) between the metal and the N + or P + diffusion region, a silicide such as NiSi 2 is added. An interconnect structure with all the dielectric etched away is shown in Fig. 3–22. From the first ICs, the interconnect metal has been aluminum, Al. Al interconnects suffer a potential reliability problem called electromigration . Electron flow in the metal line, over time, can cause the metal atoms to migrate along crystal grain boundaries or the metal/dielectric interfaces in a quasi-random manner. Voids may develop in the metal lines as a result and cause the line resistance to increase or even become open-circuited. Copper has replaced Al as the interconnect material in advanced ICs.

<a id="evidence-32"></a>

### 32. Electron Beam Evaporator Systems for Thin Film Deposition

https://www.nist.gov/mml/materials-science-and-engineering-division/electron-beam-evaporator-systems-thin-film-deposition · retrieved 2026-11-22 · text offsets 0–847

> This page is no longer being updated and the information may be out of date.
> 
> **Facility**
> 
> The Thin Film and Nanostructure Processing Group has two high-vacuum, electron beam evaporator systems for fabrication of single and multilayer thin film specimens. One system has three independent sources and is used for deposition of single and multilayer thin films of materials ranging from lower melting metals, such as aluminum, silver, and copper, up to refractory metals including ruthenium, iridium, and tungsten. The second system, shown to the right, has two independent sources, each capable of depositing as many as six different materials in a single deposition run. With its two-axis, computer-controlled specimen shutter, it is used for fabrication of combinatorial layered as well as compositionally graded specimens.
> 
> **Significance**

<a id="evidence-33"></a>

### 33. Electron Beam Evaporator Systems for Thin Film Deposition

https://www.nist.gov/mml/materials-science-and-engineering-division/electron-beam-evaporator-systems-thin-film-deposition · retrieved 2026-11-22 · text offsets 847–1737

> Projects within the Material Measurement Laboratory frequently require thin films of metals that serve as substrates, electrical contacts on substrates, or as the material of interest itself. These two deposition systems enable fabrication of films under high vacuum conditions. Films from the three-source deposition system support substantial portions of the Division's research related to microelectronic interconnects, in situ stress measurements during electrochemical processing, and semiconductor nanowires. Examples include thin films of platinum group alloys deposited into sub-100 nm feature, damascene patterned silicon wafers, which have enabled studies of so-called "seedless" processing of copper interconnects of interest to the microelectronics industry, and metallization of aluminum, titanium, nickel, and other metals used to make electrical contacts to nanowire devices.

<a id="evidence-34"></a>

### 34. Electron Beam Evaporator Systems for Thin Film Deposition

https://www.nist.gov/mml/materials-science-and-engineering-division/electron-beam-evaporator-systems-thin-film-deposition · retrieved 2026-11-22 · text offsets 1737–2331

> The two-source deposition system is dedicated to fabrication of combinatorial thin film "array" type specimens containing multiple combinations of film thicknesses and/or materials on a single specimen required for high throughput studies of materials properties. The system has been used to stack layers of elements with different magnetic properties and thicknesses for applications to magnetic storage related research. Today, it is mainly utilized to fabricate combinatorial arrays of low density materials for hydrogen storage applications.
> 
> Created November 23, 2008, Updated May 27, 2026

<a id="evidence-35"></a>

### 35. Step Coverage in Thin-Film Deposition: PVD vs. CVD vs. ALD | Semiconductor Room

https://semiconroom.com/en/term/step-coverage/ · retrieved 2026-11-22 · text offsets 2226–3118

> Gate dielectrics and metals wrapped around [FinFET](/en/term/finfet/) or [gate-all-around](/en/term/gaa/) channels, and films lining deep [3D NAND](/en/term/3d-nand/) holes, rely on [ALD](/en/term/ald/)\-level conformality. Step coverage should not be confused with gap fill: a perfectly conformal film closing a narrow trench from both sides leaves a seam, and void-free filling may need deposition–etch cycles. Sometimes poor coverage is wanted, as in lift-off, where line-of-sight evaporation keeps films on resist sidewalls discontinuous.
> 
> ## Try it: questions about Step coverage
> 
> ### [Which correctly describes step coverage in deposition?](/en/q/deposition/deposition-004/)
> 
> 1.  AHow thick the film deposited on the sidewalls and bottom of a step is compared with flat areas
> 2.  BThe electrical resistance of the film
> 3.  CThe deposition rate per minute
> 
> Show answer and explanation

<a id="evidence-36"></a>

### 36. Miniaturization of CMOS

https://pmc.ncbi.nlm.nih.gov/articles/PMC6563067/ · retrieved 2026-11-22 · text offsets 0–297438

Literal matches in the stored extraction: "molecular beam epitaxy" (0), "MBE" (41), "evaporation" (0), "e-beam" (0), "electron beam" (1), "sputter" (0), "PVD" (10), "ALD" (71), "CVD" (18), "silicide" (2), "barrier" (33), "liner" (20), "seed layer" (1), "TiN" (175), "TaN" (139), "work function" (19), "Mn" (0), "self-forming" (0), "Ru" (186), "Mo" (554), "Co " (50).

<a id="evidence-37"></a>

### 37. Novel Atomic Layer Processes for Semiconductor Manufacturing: Area Selective Deposition, Atomic Layer Annealing, and Atomic Layer Etching

https://link.springer.com/article/10.1007/s12541-025-01337-z · retrieved 2026-11-22 · text offsets 0–153735

Literal matches in the stored extraction: "molecular beam epitaxy" (0), "MBE" (10), "evaporation" (0), "e-beam" (0), "sputter" (3), "PVD" (6), "TiN" (129), "TaN" (47), "work function" (0), "silicide" (0), "Mn" (6), "Ru" (85), "Mo" (246), "W " (62), "gate metal" (0), "barrier" (2).

<a id="evidence-38"></a>

### 38. Chenming Hu ch3

https://www.chu.berkeley.edu/wp-content/uploads/2020/01/Chenming-Hu_ch3.pdf · retrieved 2026-11-22 · text offsets 0–58261

Literal matches in the stored extraction: "molecular beam" (0), "MBE" (12), "evaporation" (0), "e-beam" (0), "electron-beam evaporation" (0), "sputter" (18), "PVD" (1), "CVD" (23), "ALD" (0), "silicide" (1), "NiSi" (2), "TiSi" (0), "Cu seed" (0), "TaN" (26), "TiN" (51), "electroplating" (0), "tungsten" (0).

<a id="evidence-39"></a>

### 39. Chenming Hu ch3

https://www.chu.berkeley.edu/wp-content/uploads/2020/01/Chenming-Hu_ch3.pdf · retrieved 2026-11-22 · text offsets 41194–42081

> Also, a different material may be epitaxially deposited over the substrate material as long as the film and the substrate have closely matched lattice constants (see Section 1.1). Epitaxially grown dissimilar materials are widely used in light-emitting diodes (see Fig. 4–30) and diode lasers (see Fig. 4–33). The interface between two different semiconductors is called a hetero-junction . An application example of selective hetero-junction epitaxial growth (of SiGe over Si) may be found in Fig. 7–1. 3.8 INTERCONNECT—THE BACK-END PROCESS To build an IC, the individual devices must be interconnected by metal lines. This procedure is sometimes called metallization . A basic interconnect is illustrated in Fig. 3–21a. First, the SiO 2 is removed from areas where a contact is to be made with the silicon. Then a layer of metal is deposited over the surface, typically by sputtering.
