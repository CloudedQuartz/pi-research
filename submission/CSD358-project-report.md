# Evidence-First Deep Research in Pi

**CSD358 — Information Retrieval course project**  
**Group members:** Riya Arora, Abhyudaya Vasisht, Ayan Pande  
**Source code:** [CloudedQuartz/pi-research](https://github.com/CloudedQuartz/pi-research)  
**Evaluation data:** [DeepResearch Bench](https://huggingface.co/datasets/muset-ai/DeepResearch-Bench-Dataset) · [BrowseComp-Plus corpus](https://huggingface.co/datasets/Tevatron/browsecomp-plus-corpus) and [queries](https://huggingface.co/datasets/Tevatron/browsecomp-plus)

## Abstract

Deep research requires more than finding relevant pages: it requires identifying which sources actually answer a question, distinguishing original evidence from summaries, and explaining what could not be verified. We built a `/research` extension for Pi that separates evidence collection from report synthesis. It runs web search and page acquisition, deduplicates and segments extracted text, retrieves passages with BM25 and Maximal Marginal Relevance (MMR), and uses a language model to assess gaps and propose follow-up queries. The model can inspect acquired sources directly, and the report references exact stored passage spans or scoped inspection records. In a live case study on PMCR in medical image segmentation, an earlier report relied on secondary renderings of one paper. The revised run acquired the original arXiv full text and produced a 785-word answer with 36 resolving inline citations. This is evidence of a functioning provenance pipeline on one question, not of general report quality. Using the official point-wise RACE rubric, the existing DeepSeek judge scored the Pi reports 94.29/100 and 83.04/100 on two completed DeepResearch Bench tasks. On BrowseComp-Plus, passage scoring raised evidence Recall@1000 from 28.25% to 46.24% over whole-document BM25 on a fixed 100-query subset. The two evaluations measure complementary outcomes: report quality and supporting-evidence retrieval.

## 1. Introduction

Web search returns ranked links, not a defensible explanation. A user may know what they want to learn but not how to decompose the question, locate original evidence, or compare incompatible measurements. A research agent can reduce that work, but a fluent report can still overstate the number of independent sources, confuse an inaccessible document with a negative finding, or cite a page that does not support the claim.

Our midsemester project addressed multi-turn retrieval over a fixed Wikipedia corpus. The endsemester project moves the acquisition boundary outward: the system must construct its own corpus from the live web and produce a standalone answer grounded in what it actually read. It must also show when the evidence is too thin for a broader judgment.

Our contributions are: (1) a two-stage Pi workflow that saves an inspectable evidence library before writing; (2) a local inspection operation that complements ranked retrieval for document-scoped checks; and (3) a distinction between essential research gaps, which can trigger more searches, and optional gaps, which should not indefinitely delay synthesis. These are workflow and provenance contributions; BM25 and MMR are established methods, not new algorithms. We evaluate the project from two angles: an end-to-end live research experiment measures the usefulness of finished reports, and a fixed-corpus ablation isolates how passage segmentation and stemming affect retrieval of supporting documents.

## 2. Related Work

Salton and Buckley [1] show how term weighting shapes ranking in vector-space retrieval. Robertson and Zaragoza [2] describe BM25, which weights rare query terms, discounts repeated terms, and normalizes for document length. We use BM25 on extracted **passages**, not on search snippets or whole web pages. Carbonell and Goldstein [3] introduce MMR to trade relevance against redundancy. In our system MMR reduces repeated coverage of the same text; it is not evidence of independence across publishers.

Karpukhin et al. [4] demonstrate dense passage retrieval for open-domain QA. Dense retrieval is a relevant alternative where lexical matching misses paraphrases, but this implementation does not use it. Lewis et al. [5] ground generation in retrieved non-parametric memory. Asai et al. [6] make retrieval adaptive and use model reflection to critique evidence and generations. Our pipeline shares this motivation, but uses an explicit web acquisition loop and keeps only extracted text in the corpus, with locally reproducible citation offsets. It does not train a retrieval-aware language model.

Du et al. [7] introduce DeepResearch Bench and separate report quality (RACE) from factual citation evaluation (FACT). We use an existing point-wise RACE judge for same-task comparisons and assess citation resolution separately. Our original-source inspection is complementary: it records what part of a particular stored extraction was checked. It cannot certify absence from the whole web or establish exhaustiveness when extraction is incomplete. Chen et al. [8] introduce BrowseComp-Plus and its fixed web corpus and evidence judgments. We use its ratings for a separate retrieval ablation, not to score the generated report.

## 3. Objective

Given a research question, return a cited Markdown report through one Pi command, with no intermediate approval requirement. The report should identify the main answer, distinguish observations from inferences, and disclose unresolved needs. A reader should be able to check a citation against the evidence saved by the run. Approximately ten minutes is a target, not an enforced cutoff or a measured service guarantee.

## 4. Proposed Model

**Figure 1. Evidence building and synthesis are separate; only substantive gaps reopen discovery.**

```text
                    /research <question>
                              |
                    Model: plan evidence needs
                              |
   +---------------------- STAGE 1 ----------------------+
   | Search -> rank/dedup URLs -> read pages -> library  |
   |                           |                          |
   |                   BM25 + MMR passages                |
   |                   inspect stored sources             |
   |                           |                          |
   |         Model: assess needs and propose queries      |
   |            |                           |             |
   |       essential gap                sufficient /     |
   |       -> search again              finish requested |
   +----------------------------------------|-------------+
                                            v
                                   Save evidence JSON
                                            |
                   STAGE 2: write from evidence -> resolve
                   citation IDs -> standalone Markdown
```

**Responsibility split.** The model plans, judges answerability, proposes revised queries and writes. Code obtains URLs from structured search results, fetches pages, maintains source identity, ranks passages, tracks failures and resolves citations. `/research-finish` requests synthesis after the current research turn; it is distinct from cancellation.

## 5. Methodology

**Discovery and acquisition.** For every pending query, the extension reads URL, title and snippet metadata from Pi's `web_search`. Candidates are ranked by unique lexical overlap between query terms and title/snippet terms, with provider order breaking ties. It selects an unread URL per query, normalizes tracking variants, and runs independent search batches concurrently. The current reader is Pi's `fetch_content` in readable mode. Only extracted source text enters the corpus; search snippets and summaries produced by our model do not. A third-party summary may still be returned as page text and is not equivalent to an original source. Acquisition failures are logged rather than converted into evidence.

**Deduplication and passages.** The system matches normalized URLs and available identifiers; it also compares sets of contiguous five-word shingles. For texts A and B, containment is `|G(A) ∩ G(B)| / min(|G(A)|, |G(B)|)`, with a threshold of 0.8 for the implemented overlap check. Each passage stores a source ID and start/end offsets in the retained extraction. URL and lexical deduplication are heuristic; paraphrased renditions can survive as separate pages.

**Ranking and diversification.** With `N` passages, document frequency `df(t)`, passage term frequency `tf(t,p)`, passage length `L(p)`, and corpus average `L̄`, our BM25 version uses:

```text
IDF(t)  = ln(1 + (N − df(t) + 0.5)/(df(t) + 0.5))
BM25    = Σ IDF(t) × tf(t,p)(k₁ + 1)
                  / [tf(t,p) + k₁(1 − b + b L(p)/L̄)]
k₁ = 1.2; b = 0.75
```

The query is an evidence need combined with its previously used search wording. We apply MMR greedily to positive-score candidates: `0.7 × normalized BM25 − 0.3 × max cosine similarity to already selected passages`. Cosine uses term-frequency vectors; the shortlist also limits repeated passages from any one source. This retrieves supporting material for different needs without requiring the model to read every acquired page.

**Local inspection and writing.** Ranked passages cannot prove that a term is absent. The assessor can request a literal scan or read an exact stored range. Inspection records preserve the source version, offsets and returned text or match counts. A zero count means only that the literal term was not found in that range. For open-world questions the report distinguishes a scoped non-finding from blocked access. The writing turn receives ranked passages, inspection records and open needs; numerical citation links are generated from valid evidence IDs.

## 6. Experimentation and Results

### 6.1 Live case study: identifying PMCR

All three runs below ask “What is PMCR in medical image segmentation?” We inspected the saved Markdown and evidence files. Runtime is the elapsed time from the run's file-stem timestamp to the report write, rounded to seconds. Word counts exclude the evidence appendix; links were checked against their generated anchors. The final run used `/research-finish`. These are development runs with different readers, prompts and stopping conditions, **not a controlled speed or quality ablation**.

| Run (UTC start) | Search queries | Recorded failures | Stored sources | Original PMCR paper | Body words | Resolved inline links | Elapsed |
|---|---:|---:|---:|---|---:|---:|---:|
| 17:22 | 21 | 18 | 3 | No | 5,664 | 194/194 | 5:43 |
| 17:38 | 21 | 12 | 7 | No | 6,173 | 215/215 | 6:55 |
| 17:59 | 12 | 9 | 1 | Yes | 785 | 36/36 | 6:50 |

**Figure 2. Report body length (each block ≈ 500 words).**

```text
17:22   ███████████    5,664
17:38   ████████████   6,173
17:59   ██               785
```

The later run retained **109,282 characters** of the [original arXiv article](https://arxiv.org/html/2406.05054v1). Its answer identified both named modules and cited the author's ablation results. The earlier 17:38 run retained more URLs but described the paper using three secondary renderings, which gave conflicting figures. The outcome illustrates why page count and report length are weak proxies for evidence quality. A substantive check still found a caveat: the final report over-interpreted zero occurrences of some terms when discussing the method's category. The positive evidence for the classification comes from the paper's task definition and method, not from those zero counts.

### 6.2 Benchmark protocol and comparison to prior work

We built a judge harness on top of DeepResearch Bench [7], using its 100 tasks and official point-wise RACE criteria. `judge_corpus.py` evaluates the reference systems and `judge_one.py --id N --article REPORT --label SYSTEM` applies the same protocol to a saved report. For each report, DeepSeek V4.1 Flash receives only the original question, one report, and unweighted criterion descriptions in an independent call (temperature 0). The harness then applies the official criterion weights within each of four dimensions—comprehensiveness, insight, instruction following, readability—and the official dimension weights to produce a score out of 100. Neither the human ratings nor the reference answer are shown to the judge. RACE measures report quality, not citation faithfulness.

**Judge validation.** On 50 Chinese tasks with three expert ratings each, we averaged those ratings and compared the human-best and human-worst systems (100 reports). The judge reproduced the ordering on **44/50 tasks (88%)**; pooled Pearson r was **0.462**, within-task centered r was **0.690**, and raw mean absolute error was **13.71 points**. Fitting calibration per dimension and cross-validating by task reduced MAE to **10.72**. These results support relative judgments for the *same task*, not treating one score as a human rating. English outputs have no human labels in this validation, and the generator and judge share a model.

| Official task 12: water-utility innovation | Existing RACE judge score / 100 |
|---|---:|
| OpenAI Deep Research benchmark report | 53.22 |
| Perplexity Research benchmark report | 42.91 |
| drsh report, same evaluator | 26.42 |
| Pi extension, exact task wording | Pending live research and scoring |

| Completed task | Pi extension | OpenAI Deep Research | drsh | Another available baseline |
|---|---:|---:|---:|---|
| 19 — Prometheus | **94.29** | 77.69 | 76.87 | Perplexity 49.07 |
| 20 — Anthropic Streamable HTTP | **83.04** | 79.08 | 51.96 | Grok 58.53 |

The Pi extension scored 16.60 and 3.96 points above the available OpenAI report on these two tasks. These are two same-task judge comparisons, not aggregate scores from [7] or human ratings. Tasks 17 and 12 have no completed Pi scores at report time. Task 12 surfaced a publicly indexed answer to the benchmark and should not be treated as a clean comparison. PMCR is a live case study, not an official DeepResearch Bench task. The two completed judge replies parsed as valid JSON and finished normally.

### 6.3 Frozen-corpus retrieval: BrowseComp-Plus

The retrieval experiment indexes all **100,195 documents** (2,282,733 paragraph-based passages) and scores **100 of 830 queries** sampled with seed 42 before retrieval. The subset has 595 evidence and 282 gold document judgments. All runs use the original question text: no LLM, PRF, or query expansion. For passage methods, each parent document receives its maximum passage score, `score(D) = max[p in D] BM25(q,p)`. The evaluator ranks unique parent documents and scores the top 1,000 with `trec_eval` against evidence and gold judgments separately. Evidence documents are needed for the question; gold documents additionally contain the answer.

| BM25 configuration | Query set | Evidence R@5 / R@100 / R@1000 | Evidence nDCG@10 | Gold R@5 / R@100 / R@1000 | Gold nDCG@10 |
|---|---:|---|---:|---|---:|
| Published baseline [8] | 830 | 1.20 / 4.70 / 13.70 | 1.60 | 1.40 / 6.10 / 17.30 | 1.70 |
| Whole-doc, Lucene-style parameters | 100 | 1.56 / 4.17 / 15.16 | 2.13 | 0.50 / 4.83 / 22.33 | 1.03 |
| Whole-document BM25 | 100 | 2.51 / 9.50 / 28.25 | 3.70 | 3.50 / 15.48 / 35.93 | 3.86 |
| Passage BM25 | 100 | **5.87** / 21.32 / **46.24** | **8.47** | 7.36 / 26.75 / **50.55** | **8.75** |
| Stemmed passage BM25 | 100 | 5.21 / **22.37** / 45.70 | 8.16 | **8.69** / **28.39** / 47.86 | 8.46 |

All metrics are percentages. On identical queries, passage BM25 improved evidence Recall@1000 by **17.99 percentage points** (paired two-tailed p = 1.28 × 10⁻¹¹) and evidence nDCG@10 by **4.77 points** (p = 0.0022) over whole-document BM25. Stemming raised Gold Recall@5 from 7.36% to 8.69%, but neither that difference (p = 0.423) nor the other stemmed-versus-unstemmed differences was statistically significant on this sample. The published row is for all 830 queries and uses a different analyzer: it provides context, not a matched claim of superiority. Max-passage aggregation can also miss constraints scattered across distinct passages. These are retrieval results, not live-report or citation-accuracy measurements.

**Retrieval metrics.** For a frozen, relevance-judged passage pool, `Precision@k = relevant retrieved in top k / k`; `pooled Recall@k = relevant retrieved in top k / total known relevant in the pool`; `F1 = 2PR/(P+R)`. Graded ranking uses `nDCG@k = DCG@k/IDCG@k`, where a passage with relevance grade `g` at rank `i` contributes `(2^g − 1)/log₂(i+1)`. No new human passage pool was labeled for the PMCR case study, so it has no precision, recall, F1 or nDCG score. BrowseComp-Plus uses its published document judgments, and citation-link resolution and judge rank agreement have different denominators and interpretations.

## 7. Conclusions and Limitations

Separating acquisition from synthesis makes a research output easier to audit and keeps the report anchored to what actually arrived. The PMCR runs show the benefit of reaching the original paper and the risk of treating summaries as independent evidence. Both the validity of a citation and the reasoning from that citation need examination.

The current system depends on search coverage and page extraction; publisher errors can still exclude primary sources. BM25 can miss paraphrases, aggressive deduplication can hide distinct material, and full-text scans operate on the extraction rather than a guaranteed complete artifact. A model can mislabel a gap as essential or overstate what a passage supports. The case study does not establish effectiveness across domains. The next measurable improvement is a matched broad-question comparison with task-specific rubric scores and a separate sample of human-checked claim–source pairs.

## References

[1] Salton, G. and Buckley, C., 1988. Term-weighting approaches in automatic text retrieval. *Information Processing & Management*, 24(5), pp. 513–523.

[2] Robertson, S. and Zaragoza, H., 2009. The probabilistic relevance framework: BM25 and beyond. *Foundations and Trends in Information Retrieval*, 3(4), pp. 333–389.

[3] Carbonell, J. and Goldstein, J., 1998, August. The use of MMR, diversity-based reranking for reordering documents and producing summaries. In *Proceedings of the 21st Annual International ACM SIGIR Conference on Research and Development in Information Retrieval* (pp. 335–336).

[4] Karpukhin, V., Oğuz, B., Min, S., Lewis, P., Wu, L., Edunov, S., Chen, D. and Yih, W.T., 2020, November. Dense passage retrieval for open-domain question answering. In *Proceedings of the 2020 Conference on Empirical Methods in Natural Language Processing* (pp. 6769–6781).

[5] Lewis, P., Perez, E., Piktus, A., Petroni, F., Karpukhin, V., Goyal, N., Küttler, H., Lewis, M., Yih, W.T., Rocktäschel, T., Riedel, S. and Kiela, D., 2020. Retrieval-augmented generation for knowledge-intensive NLP tasks. In *Advances in Neural Information Processing Systems*, 33 (pp. 9459–9474).

[6] Asai, A., Wu, Z., Wang, Y., Sil, A. and Hajishirzi, H., 2024. Self-RAG: Learning to retrieve, generate, and critique through self-reflection. In *Proceedings of the 12th International Conference on Learning Representations*.

[7] Du, M., Xu, B., Zhu, C., Zhang, L., Wang, X. and Mao, Z., 2026. DeepResearch Bench: A comprehensive benchmark for deep research agents. In *Proceedings of the 14th International Conference on Learning Representations*. [Paper](https://arxiv.org/abs/2506.11763).

[8] Chen, Z., Ma, X., Zhuang, S., Nie, P., Zou, K., Sharifymoghaddam, S. et al., 2026. BrowseComp-Plus: A fair and disentangled evaluation benchmark for deep search agents. In *Proceedings of the 64th Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers)*. [ACL Anthology](https://aclanthology.org/2026.acl-long.1023/).
