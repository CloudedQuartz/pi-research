# Information Retrieval (IR) Architecture and Improvements

Pi Research uses a specialized, inspectable Information Retrieval (IR) layer to index, score, and retrieve grounded source passages from web pages. Unlike naive retrieval systems that dump full web pages into an LLM prompt, Pi Research segments pages into bounded passages (180–300 tokens) with precise character offsets and ranks them using deterministic Information Retrieval algorithms.

This document explains the core IR mechanisms, which features are actively integrated into the live research workflow, and how each improvement works in plain language.

---

## 1. Current Workflow Integration Status

| Mechanism | Location in Code | Live in Research Engine? | Purpose & Impact |
|---|---|:---:|---|
| **Stemmed BM25 (`rankStemmed`)** | [`src/engine.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/src/engine.ts#L1114) & [`src/extension.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/src/extension.ts#L292) | **✅ YES (Active)** | Primary evidence ranker. Boosts search recall by matching word variants (`detect`/`detecting`). **+10.5% nDCG@10** on CISI benchmark. |
| **Rocchio Relevance Feedback (`rocchioQuery`)** | [`src/controller.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/src/controller.ts#L32) | **✅ YES (Active)** | Uses user feedback (`/research-feedback useful\|irrelevant`) to boost good terms and subtract bad terms, stopping query drift. |
| **Pre-Fetch Candidate Classifier (`NaiveBayesCandidateClassifier`)** | [`src/controller.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/src/controller.ts#L60) | **✅ YES (Active)** | Prunes off-topic search candidates *before* fetching them, protecting HTTP and model-call budgets. |
| **Passage Clustering into Facets (`clusterPassages`)** | [`src/core-ir.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/src/core-ir.ts) | **✅ Available** | Spherical $k$-means clusters passages by topic and labels them using top centroid terms to suggest new research branches. |
| **Comprehensive Evaluation Suite (MAP, BPref, t-test)** | [`scripts/evaluate.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/scripts/evaluate.ts) | **✅ YES (Active)** | Offline evaluation harness measuring MAP, R-Precision, BPref, 11-point P-R curves, and paired Student's $t$-tests. |
| **Query-Likelihood (QL) & Sequential Dependence Model (SDM)** | [`src/core-ir.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/src/core-ir.ts) & [`scripts/evaluate.ts`](file:///c:/Users/riyaa/Documents/code/pi-research/scripts/evaluate.ts) | **🔬 Evaluated (Offline)** | Implemented for benchmark comparison and ablation studies across probabilistic, language modeling, and Markov Random Field methodologies. |

---

## 2. Understandable Explanations of Each Core Feature

### A. Stemmed BM25 (The Primary Live Ranker)

* **The Problem:** 
  Standard BM25 treats every spelling variation as a completely different word. If your query is `"detecting pipeline failures"` and the best passage in the document says `"automatic detection of pipeline failures"`, unstemmed BM25 gives zero credit to `"detecting"` because it does not match `"detection"`.
* **How It Works:** 
  We implemented the complete Martin Porter (1980) English stemmer algorithm. It reduces words to their common root (`detect`, `detection`, `detecting` $\rightarrow$ `detect`; `retrieval`, `retrieving` $\rightarrow$ `retriev`).
* **The Critical Invariant (No Text Mutation):**
  In Pi Research, every sentence cited by an LLM report must point to exact UTF-16 character offsets in the original raw web page. Therefore, stemming **never modifies the raw text or surface tokens**. Instead, `PassageIndex` builds a parallel stemmed stream (`stemPostings` and `stemDf`). Scoring happens on stems, but passages and citation spans remain 100% truthful to the raw source.
* **The Result:** 
  On the 76-query CISI benchmark, stemmed BM25 delivered an immediate **+10.46% gain in nDCG@10** and **+17.0% gain in Precision@10** over unstemmed BM25.

---

### B. Rocchio Relevance Feedback (Stopping Query Drift)

* **The Problem:** 
  Earlier versions of query expansion used "pseudo-relevance feedback" (PRF): they blindly assumed that the top 5 search results were relevant, extracted frequent words from them, and added those words to the query. If any top result was off-topic (e.g. an image-processing article that mentioned the word "skew"), the query would pull in words like "camera" or "pixel", steering all future research rounds completely off-topic (query drift). On CISI, this blind expansion dropped retrieval quality by ~20%.
* **How It Works:** 
  We replaced blind expansion with classic **Rocchio Relevance Feedback**:
  $$\vec{q}_{new} = \alpha \vec{q}_0 + \beta \frac{1}{|D_{useful}|} \sum \vec{d}_{useful} - \gamma \frac{1}{|D_{irrelevant}|} \sum \vec{d}_{irrelevant}$$
  When a user runs `/research-feedback useful <id>` or `/research-feedback irrelevant <id>`, the engine:
  1. Adds high-scoring terms from `useful` passages ($\beta$).
  2. **Subtracts terms from `irrelevant` passages ($-\gamma$)**: If an irrelevant passage contains "camera" or "image", those weights become negative and are completely removed.
* **The Result:** 
  The search query actively moves *away* from off-topic noise and *toward* verified evidence, preventing topic drift.

---

### C. Pre-Fetch Candidate Classification (Budget Protection)

* **The Problem:** 
  In real research runs, evaluating downloaded web pages with an LLM was the single largest bottleneck—consuming **24 out of 25 model calls**. Furthermore, downloading off-topic search results burned precious HTTP fetch credits.
* **How It Works:** 
  We implemented a fast, deterministic **Multinomial Naive Bayes classifier** with Laplace smoothing (`NaiveBayesCandidateClassifier`).
  - It trains on the words in the research question and any confirmed useful vs irrelevant feedback.
  - Before the crawler makes an HTTP network request to download a search result, the classifier inspects the candidate's search snippet and title.
  - If the candidate is predicted to be off-topic with $>60\%$ confidence, its relevance score is dropped to 0.
* **The Result:** 
  Off-topic search results are rejected *before* fetching them, preserving both HTTP fetch credits and expensive LLM assessment calls.

---

### D. Spherical $k$-Means Passage Clustering into Facets

* **The Problem:** 
  When hundreds of passages have been collected, it is difficult for a user to see what sub-topics or themes have emerged without reading every single passage.
* **How It Works (`clusterPassages`):** 
  1. Computes TF-IDF vector representations of all passages.
  2. Runs spherical $k$-means clustering using cosine similarity with deterministic $k$-means++ seeding.
  3. Computes the centroid (center of gravity) of each cluster.
  4. Identifies the top 3 most discriminative terms in each centroid and combines them into a human-readable label (e.g. `"pipeline | divergence | feature"`).
* **The Result:** 
  Surfaces natural topic groupings in `/research-map`, providing data-driven recommendations for new research branches.

---

### E. Query-Likelihood & Sequential Dependence Model (Ablation Alternatives)

* **Why They Exist:** 
  In academic Information Retrieval, it is standard practice to implement and compare multiple competing foundational paradigms:
  1. **Probabilistic Model (BM25)**: Heuristic term saturation ($k_1$) and length normalization ($b$).
  2. **Statistical Language Model (Query-Likelihood Dirichlet, `rankQL`)**: Estimates the probability that a document's word distribution generated the query with Bayesian Dirichlet smoothing ($\mu = 2000$).
  3. **Markov Random Field (Sequential Dependence Model, `rankSDM`)**: Linearly combines unigram terms ($85\%$), exact ordered pairs ($10\%, \#1$), and nearby window terms ($5\%, \#8$) to reward words appearing close together.
* **Status:** 
  Both QL and SDM are fully implemented in `src/core-ir.ts` and evaluated in `scripts/evaluate.ts`. Per our evaluation on CISI, stemmed BM25 proved to be the most effective for natural language research queries, so QL and SDM serve as the evaluation comparison baselines in our final report.

---

## 3. CISI Benchmark Results Summary

The evaluation suite scored all 6 methods across 76 human-judged queries and 1,459 documents:

| Method | Description | P@5 | P@10 | nDCG@10 | Pooled Recall@10 |
|---|---|:---:|:---:|:---:|:---:|
| **`bm25stem`** | **BM25 with Porter Stemming (Active Live Ranker)** | **0.4263** | **0.3632** | **0.3984** | **0.1470** |
| `bm25` | Original unstemmed BM25 baseline | 0.3895 | 0.3105 | 0.3607 | 0.1360 |
| `ql` | Dirichlet Language Model ($\mu=2000$) | 0.3684 | 0.2921 | 0.3390 | 0.1392 |
| `sdm` | Sequential Dependence Model (MRF Bigrams + Windows) | 0.3605 | 0.2921 | 0.3338 | 0.1275 |
| `lexicalPRF` | Blind Pseudo-Relevance Feedback (Original baseline) | 0.2974 | 0.2566 | 0.2902 | 0.0955 |
| `prfMMR` | PRF with MMR Diversity Re-ranking | 0.2868 | 0.2474 | 0.2821 | 0.0915 |

### Statistical Significance:
Using the newly implemented paired two-tailed Student's $t$-test across all 76 queries:
- **`bm25stem` vs `bm25`**: Mean nDCG difference $+0.0377$, $t = 3.82$, $p = 0.00027$ ($p < 0.001$).
- The improvement of stemmed BM25 over the baseline is **statistically significant at the 99.9% confidence level**.
