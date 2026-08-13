/**
 * Seed Kristi's reference knowledge corpus into the vault — the demand-side +
 * deep-compute FRAMING she needs to derive grounded persona/ICP/UCP profiles and
 * to read the workstation market above brochure level. Re-runnable (overwrites
 * the same notes by id).
 *
 *   docker compose exec hearth-orchestrator bun run scripts/seed-kristi-knowledge.ts
 *
 * Writes `type: clipping` notes (specialist_scope: kristi) under
 * $HEARTH_VAULT_ROOT/Knowledge/Kristi/reference/. The ingestor indexes them →
 * Kristi's search_library + the derive_swimlane_profiles / assess_competitive_items
 * jobs (retrieve_scoped_chunks over Knowledge/Kristi/**) find them.
 *
 * PROVENANCE: distilled 2026-06-03 from a multi-agent deep-research pass
 * (saved at ~/kristi-knowledge-seed-research.md). This is DIRECTIONAL FRAMING,
 * NOT verified spec data — each note says so, carries its source radar, and
 * reminds Kristi to verify specifics against primary sources before she records
 * a spec/price row into her structured store. Vendor TOPS/peak figures are
 * tagged for de-rating. Forward dates are tagged as projections (as-of 2026-06).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const VAULT = process.env.HEARTH_VAULT_ROOT ?? resolve(homedir(), 'vault-friday');
const CAPTURED = '2026-06-03T00:00:00Z';
const PROVENANCE =
  '> **Directional research brief — framing, not verified spec.** Synthesized 2026-06-03 ' +
  'from a deep-research pass. Use it to reason about fit, bottlenecks, and who-buys-what; ' +
  '**verify any specific number against the primary sources below before you record a ' +
  'spec/price row.** Vendor TOPS/peak/sparse figures are de-rate-on-sight. Forward dates ' +
  'are projections (as-of 2026-06), not facts.';

interface Note { path: string; id: string; title: string; tags: string[]; sources: string[]; body: string }

const notes: Note[] = [
  {
    path: 'Knowledge/Kristi/reference/compute-master-frames.md',
    id: 'c_kristifr01',
    title: 'Compute master frames — memory, inference, multi-GPU',
    tags: ['compute', 'vram', 'multi-gpu', 'inference', 'bandwidth'],
    sources: ['https://lmsys.org', 'https://developer.nvidia.com', 'https://docs.nvidia.com', 'https://docs.vllm.ai', 'https://github.com/ggml-org/llama.cpp', 'https://www.servethehome.com'],
    body: `
${PROVENANCE}

## Memory architecture & AI inference
- **Two-budget VRAM model.** Usable = VRAM − weights − KV cache. KV = 2·layers·kv_heads·head_dim·seq_len·batch·bytes. Llama-3.1-70B BF16 @128K @batch-1 ≈ 42.9 GB KV *on top of* weights. FP8 70B ≈ 70 GB on a 96 GB card leaves ~26 GB KV → moderate batch but NOT 128K. Mitigations: GQA, FP8/INT8 KV-quant (~halves), PagedAttention (~10× concurrency). **"Loads the model" ≠ "serves long-context agents at batch 8" — always quote usable-at-X-context/Y-batch/which-engine, never bare param count.**
- **Decode vs prefill bandwidth.** Decode tok/s ≈ memory-bandwidth ÷ active-bytes-per-token (memory-bound); prefill is compute-bound. DGX Spark (LMSYS): GPT-OSS-20B ~2,053 tok/s prefill / 49.7 decode; Llama-70B FP8 ~803 / 2.7. Spark shines at batch + prefill-heavy agentic dev, NOT single-stream chat. RTX PRO 6000 ~4× Spark prefill.
- **Unified-memory fork — THREE shipping data points** (the disruption thesis lives or dies on comparing these against *effective decode bandwidth*, not peak FLOPS): **DGX Spark / GB10 — ~273 GB/s LPDDR5X** (the "up to 900 GB/s" is NVLink-C2C internal, NOT weight bandwidth — settled) · **Apple Mac Studio M3 Ultra — 512 GB unified @ ~819 GB/s, ships today + MLX stack** (no CUDA/NIM/ISV-cert path) · **AMD the integrated AI accelerator / Ryzen AI Max+ 395 — 128 GB unified @ ~256 GB/s** (x86 unified-memory entry). Discrete: GDDR7 ~1.8 TB/s (RTX PRO 6000); GB300 coherent 784 GB (496 GB LPDDR5X + 252 GB HBM3e @ ~7.1 TB/s via 900 GB/s C2C).
- **FP4.** NVFP4 (16-value blocks, FP8 scale): ~88% lower quant error, near-FP8 accuracy @ ~2.3× throughput, TensorRT-LLM since v0.17. MXFP4 (OCP, GPT-OSS): 32-value. FP4 ~halves memory + ~2× compute vs FP8 — how a 200B model "fits" on a 128 GB Spark.
- **Engine flips the verdict.** vLLM/SGLang (PagedAttention + continuous batching) = concurrency kings (>35× req throughput vs llama.cpp under load); Ollama/llama.cpp = simple single-user, serialize under load. TensorRT-LLM = NIM's path, best FP4. Track ROCm-vLLM / Apple-MLX as the non-NVIDIA engine columns.
- **96 GB QLoRA line.** Single-card 70B QLoRA: 4-bit base ~35-40 GB + headroom. RTX PRO 6000 = only sub-$10k card running 70B >Q4 on one GPU; AMD MI300X (192 GB) clears it with room.

## Multi-GPU & rendering
- **No VRAM pooling.** Every renderer (Octane/Redshift/V-Ray/Arnold/Cycles) mirrors the full scene per card → effective VRAM = the SMALLEST card. "2× 96 GB = 192 GB scene budget" is FALSE (stays 96 GB). Last pooling = NVLink on RTX A6000; **dropped on RTX 6000 Ada — gone from PRO cards, but alive on datacenter Blackwell (B200/GB200).** State it precisely.
- **Scaling efficiency (intra-frame).** Octane ~97/92/88% @2/4/8 GPU; Redshift ~1.9×@2; V-Ray ~90/80-85% @2/4; Cycles-OptiX near-linear. Frame-parallel ~100% but needs per-card fit.
- **Out-of-core = safety net, not a workflow.** 2-8× PCIe penalty (Gen5 ~64 GB/s vs ~1.8 TB/s GDDR7 ≈ 28× cliff). OpenVDB volumes CAN'T go out-of-core → hard fail. Size the GPU to fit the typical scene.
- **Electrical ceiling defines "workstation."** True workstation ≈ 2×600 W or 4×300 W GPUs. 4×600 W = 2400 W > ~1440 W safe @15 A/120 V → needs **20 A/120 V or 240 V**. An "8-GPU workstation" is a relabeled HGX/DGX server (NVSwitch, 3000 W+) or throttled. Liquid cooling solves heat, not the breaker.
- **AI vs render multi-GPU = OPPOSITE.** Render = embarrassingly parallel, PCIe-only fine. AI training = communication-bound, NVLink decisive, PCIe-only Blackwell takes 3-4× hit. A 4× RTX PRO box: great render + single-card inference, mediocre multi-card LLM training (deliberate segmentation vs datacenter). On AMD the multi-accel fabric is Infinity Fabric.
- **NVENC/NVDEC** = fixed-function blocks; engine count is a segmentation lever and often bottlenecks before tensor cores (surveillance/broadcast). The old "GeForce 3-stream NVENC cap" is HISTORICAL (lifted ~2023). Blackwell 9th-gen NVENC adds 4:2:2 (broadcast color) + up to 4 encoders.
- **ECC reliability economics.** Pro-card ECC (GDDR + system RAM) catches SEU bit-flips that silently corrupt a 40-hr sim (worst failure: wrong answer, no crash). GeForce lacks VRAM ECC. The pro premium = ECC + ISV cert + Production-Branch drivers + sustained thermals + lifecycle + vGPU.
`,
  },
  {
    path: 'Knowledge/Kristi/reference/isv-workflow-physics.md',
    id: 'c_kristiisv1',
    title: 'ISV workflow physics — what gates each pro app',
    tags: ['isv', 'workflow', 'cad', 'cae', 'aec', 'eda', 'life-sci', 'bottleneck'],
    sources: ['https://www.ansys.com', 'https://openusd.org', 'https://www.pugetsystems.com', 'https://www.solidworks.com/support/hardware-certification', 'https://knowledge.autodesk.com', 'https://guide.cryosparc.com'],
    body: `
${PROVENANCE}

The analyst's edge is classifying the GATING RESOURCE by workload PHASE, never comparing on raw core count across phases.

## Viewport vs solver — the master split
- **CAD modeling** (SOLIDWORKS / Creo / NX / Inventor / Revit) = single-thread geometry kernel → **clock-bound**: a 5.8 GHz part rebuilds ~30% faster than 4.5 GHz regardless of 8 vs 64 cores.
- **Solver inverts** to multi-core / GPU / RAM-bound. Implicit FEA scaling diminishes ~12-16 cores.
- De-rate MOBILE parts to sustained-thermal reality (mobile RTX PRO 35-175 W ≠ desktop 300-600 W).

## GPU solver VRAM cliff
- Ansys ~1-3 GB VRAM per million mesh cells; doesn't fit → fails or slow CPU-hybrid (cuDSS). 96 GB vs 32 GB decides whether a 30-90M-cell case runs *at all*. GPU mode is gated behind CFD Enterprise / HPC Ultimate licenses.
- CPU sparse-direct (MAPDL, Abaqus/Standard) wants 128-512 GB+ ECC in-core.

## AEC = three distinct profiles (don't fuse them)
- **BIM editor** (single-thread CPU + RAM) · **viz layer** (Enscape/V-Ray/Twinmotion/Unreal — GPU/RT/VRAM) · **reality capture** (parallel CPU + huge RAM + fast NVMe, then GPU for billions of points).

## EDA = fan-out batch
- GB-RAM-per-core is the defining spec (signoff/P&R 8-16+ GB/core; full-chip >1 TB). EDA license availability is the real limiter. GPU SPICE emerging (PrimeSim ~5×) = NVIDIA wedge. Interactive seat = thin client into a farm.

## Life-sci split
- cryo-EM (RELION, cryoSPARC — version per release-notes URL) GPU 1-2 orders of magnitude; cryoSPARC Live ~4 GPUs + multi-TB NVMe scratch. Clara Parabricks ~30 hr→<1 hr genomics (vendor figure — cite + scope hardware). Classic bioinformatics stays CPU+RAM.

## OpenUSD / Hydra / Omniverse — the workflow shift
- AOUSD (NVIDIA/Apple/Adobe/Autodesk/SideFX). Hydra render delegates (Storm/RTX/V-Ray/Arnold/RenderMan) on one scene graph; omni.hydra.rtx → live USD path tracing. Shifts offline-farm → interactive GPU path tracing → whole scene GPU-resident → VRAM + RT/Tensor + fast traversal become the spec that matters.

## The GeForce-vs-pro line (flag it per app)
- SOLIDWORKS/Dassault certify the FULL config; Autodesk certifies graphics hardware only. Cert = a tested {app version, Production-Branch driver, GPU model} tuple with support escalation rights; GeForce Game-Ready is explicitly unsupported. Cards appear in cert matrices BEFORE announcement → a leak-radar signal (watch driver Production-Branch release notes).
`,
  },
  {
    path: 'Knowledge/Kristi/reference/counter-positioning-silicon.md',
    id: 'c_kristicp01',
    title: 'Counter-positioning silicon — AMD / Intel / Apple vs NVIDIA',
    tags: ['amd', 'intel', 'apple', 'counter-positioning', 'rocm', 'gpu'],
    sources: ['https://www.amd.com', 'https://rocm.docs.amd.com', 'https://www.intel.com/content/www/us/en/products/details/discrete-gpus/arc.html', 'https://www.apple.com/mac-studio/', 'https://github.com/ml-explore/mlx', 'https://aecmag.com'],
    body: `
${PROVENANCE}

A *competitive*-intel analyst who can only talk NVIDIA is brochure-level on the most important axis. The non-NVIDIA counter-positioning IS the reason the role exists.

- **AMD Radeon PRO W7900 / W7800** — 48 GB / 32 GB GDDR6, ISV-cert (SOLIDWORKS, Adobe, DaVinci). Real VRAM-per-dollar advantage vs RTX PRO at the cert tier; the gate is **ROCm/HIP ISV-cert coverage**, not raw silicon.
- **AMD Instinct MI300X (192 GB) / MI325X (256 GB) HBM3e** — the post-NVLink CAPACITY play: single-accelerator capacity NVIDIA pro cards can't match; Infinity Fabric for multi-accel. The gate for capacity-bound CAE/LLM shops is **ROCm vLLM maturity**.
- **Intel Arc Pro B50 / B60 (24 GB) + Project Battlematrix** — the cheap-multi-GPU-LLM-box wedge. oneAPI ISV-cert coverage is thin; AEC-Magazine documents the "Intel Arc Pro ISV-trust push."
- **Apple M3 Ultra (512 GB unified, ~819 GB/s) + MLX** — direct DGX-Spark competitor for fit-a-big-model-on-a-desk, shipping at HIGHER bandwidth today; ceiling = no CUDA/NIM/TensorRT/ISV-cert ecosystem. Definition consequence: it's a **local-AI appliance, not a cert'd workstation** — classify it as such, don't put it in a tower lane.
- **The recurring question per lane:** does the workload's ISV stack actually permit the AMD/Intel/Apple path, or is it CUDA/cert-locked to NVIDIA? That answer, not the spec sheet, decides the counter-positioning.
`,
  },
  {
    path: 'Knowledge/Kristi/reference/future-compute-roadmap.md',
    id: 'c_kristirm01',
    title: 'Future compute roadmap (projections, as-of 2026-06)',
    tags: ['roadmap', 'nvidia', 'cpu', 'memory', 'pcie', 'projection'],
    sources: ['https://nvidianews.nvidia.com', 'https://www.semianalysis.com', 'https://www.nextplatform.com', 'https://www.videocardz.com', 'https://www.trendforce.com', 'https://www.jedec.org'],
    body: `
${PROVENANCE}

**EVERY date here is a projection, not a fact. Leak-grade items are tagged — never quote them as confirmed.**

- **Vera Rubin** *(proj 2H2026 ramp — NOT "Q1-2026 production")*: Rubin ~288 GB HBM4, ~13 TB/s, NVLink 6 ~5 TB/s, N2, ~2000 W; Vera CPU 88 custom-Arm cores / 176 threads. Rubin CPX = disaggregated inference (GDDR7 prefill + HBM4 decode) — legitimizes GDDR7 staying on pro cards. Rubin Ultra *(proj 2H2027)*.
- **GB10 = N1X = RTX Spark** — one silicon, three faces: **DGX Spark GA'd Oct 2025** · **RTX Spark projected ~2H2026 consumer wave** (Windows-on-Arm, ~8 OEMs + Surface) · the N1X workstation/edge face. 2-Spark cluster (200 Gbps) serves ~405B FP4.
- **DGX Station GB300** — 72-core Grace + Blackwell Ultra, 784 GB coherent, ~20 PFLOPS FP4, ~1T-param models; OEMs ASUS/Dell/Gigabyte/HP (ZGX Fury)/MSI/Supermicro; Windows *projected Q4*. HBM3e deskside = datacenter memory on a desk.
- **x86 CPU.** Intel Diamond Rapids (Xeon 7, 18A-P) — *LEAK-GRADE (VideoCardz/SemiAnalysis tier — do not quote as fact)*: ≤192 P-cores, PCIe Gen6, CXL Gen3, ~500 W, "~mid-2027 slip." AMD Threadripper PRO 9000-WX "Shimada Peak" (Zen 5, Jul 2025): ≤96C/192T, 350 W, 8-ch, 128 PCIe5 lanes; **flagship 96C MSRP ~$11,699** (line spans far lower — label as flagship, not "the part").
- **Memory modules.** MRDIMM (~2× effective, Intel/Xeon-only); CAMM2 (DDR5-9600); **LPCAMM2** (LPDDR5X, upgradable, ships ThinkPad P1 Gen7 / Dell Pro Max) — the mobile/SFF memory story; CUDIMM (CKD); HBM4 *(proj ~2026)*.
- **PCIe Gen6 / CXL.** Gen6 (PAM4, 64 GT/s) servers ~2027 (Diamond Rapids / EPYC Venice), consumer ~2028-30. CXL (.io/.cache/.mem) HEDT-only AIC today (TRX50/W790).
- **Power/cooling.** 600 W RTX PRO 6000 → 12V-2x6 (ATX 3.1); multi-GPU needs 2000-3000 W PSU + 20 A/240 V; factory liquid into towers; immersion/rear-door = datacenter only.
- **Memory supply (time-series, NOT a constant — tag every quote with as-of date).** GDDR7 ~50% cheaper/GB than HBM (why pro cards use it). AI supercycle: 16 GB GDDR7 ~$65-80 mid-2025 → >$200 early-2026 *(directional, volatile)*; memory = 70-80% of a high-VRAM GPU's BOM → leading indicator of GPU/system price.
`,
  },
  {
    path: 'Knowledge/Kristi/reference/oem-verticals.md',
    id: 'c_kristioem1',
    title: 'OEM / vertical beat — edge, surveillance, broadcast, smart-city, retail',
    tags: ['oem', 'vertical', 'surveillance', 'broadcast', 'smart-city', 'retail', 'edge', 'jetson'],
    sources: ['https://ipvm.com', 'https://developer.nvidia.com/embedded/jetson', 'https://www.edge-ai-vision.com', 'https://www.dell.com/en-us/dt/oem/index.htm', 'https://smpte.org', 'https://www.ul.com'],
    body: `
${PROVENANCE}

**Scope rule (Jasper's call): Kristi owns the SILICON / compute-sizing angle of every vertical; vendor business-strategy / market-share / TAM is context, not an owned beat — unless it gates a hardware design win.**

## Edge compute model
- **Jetson SoM model.** NVIDIA sells the System-on-Module; the OEM owns carrier/I-O/enclosure/cert/thermals/design-win. Jetson Thor: 96 5th-gen Tensor cores, 128 GB LPDDR5X @ 273 GB/s, 40-130 W; dev kit $3,499. IGX Thor = pin-compatible + Functional Safety Island + ISO 26262 ASIL-D / IEC 61508 + 10-yr; IGX T7000 pairs RTX PRO 6000 Max-Q + ConnectX-7.
- **Edge accelerators (de-rate vendor TOPS).** Hailo-8 ~26 TOPS @2.5 W *(peak INT8)*; Axelera Metis ~214 TOPS *(peak)*; Qualcomm Cloud AI 100; Ambarella CV5/CV7 (on-chip ISP). They attack Jetson on TOPS/W + price, LOSE on the Metropolis/DeepStream ecosystem lock — that ecosystem moat, not the ISA, is the real edge battle.
- **At the edge the x86-vs-Arm verdict is INVERTED vs the desktop:** Jetson (Arm + Linux) won the device tier; x86 holds only the aggregation/edge-server tier.

## OEM/embedded go-to-market = an industrial supply contract
- Frozen-BOM, 5-10 yr lifecycle, PCN discipline, de-brand / BIOS-rebrand, regulatory cert gates (IEC 60601 medical, NEBS L3, EN 50155 rail, MIL-STD-810). HP up to 10-yr service + LTSC + BIOS lock; Dell OEM-Ready + OEM Identity Module; Lenovo OEM/embedded + ThinkEdge SE; OnLogic Revision Control. A silent component change triggers a re-cert costing more than the hardware. **Retail price-per-spec analysis structurally MISSES where vendors defend margin here.**

## Surveillance (VMS)
- Storage sizing: GB ≈ cameras × Mbps × days × 10.8; 4K 24/7 ≈ 400 GB+/mo; H.265 ~50% vs H.264. Surveillance HDD (WD Purple / Seagate SkyHawk); consumer SSDs burn endurance in 12-24 mo under 24/7 write. DeepStream: YOLOv8s INT8 ~12-20 streams/30 fps on an L4 *(vendor figure — cite)*. ONVIF Profile M = analytics interop.
- **NDAA §889 beneficiary map** (track as a supply_signal / platform_shift time-series): bans Hikvision/Dahua/HiSilicon (Raysharp added Oct 2024) → displaced volume flows to **Motorola Solutions (Avigilon Unity/Alta/ACC + Pelco + WatchGuard), Hanwha Vision (Wisenet), Axis, Bosch, i-PRO.**

## Broadcast
- ST 2110 (-20 video / -30 audio / -40 ancillary / -21 timing / -22 JPEG XS); 4K59.94 ~12 Gbps/stream. Rivermax + GPUDirect zero-copy NIC↔GPU; PTP hardware clock; RTX PRO Sync drives up to 32× 4K wall; Unreal nDisplay frustum rendering = densest GPU/seat.
- **Graphics ISVs (the named RTX-PRO+Sync buyers):** Vizrt (Viz Engine 5), Ross Video (XPression / Voyager-UX on Unreal / Carbonite), Chyron (PRIME), Brainstorm, Zero Density (Reality), Pixotope, disguise (xR/ICVFX media server).

## Smart-City / ITS & Retail edge
- **ITS:** Metropolis for ITS; ALPR/LPR + traffic flow + V2X; pole Jetson → cabinet edge box → city DC; cabinet thermal gate = -40→+85 °C survival. Integrators (context): Iteris, Kapsch, Cubic/Trafficware, Econolite.
- **Retail:** loss-prevention/shrink, autonomous checkout (AiFi, Amazon JWO), planogram/shelf, queue analytics; NVIDIA Smart-Store Blueprint; the in-store **edge_server micro-DC = the "back office" tier**. SIs (context): NCR Voyix, Toshiba Global Commerce, Diebold Nixdorf, Zebra.
- **Edge market sizing = context tier (state scope, never one number):** BCC $11.8B(2025)→$56.8B(2030); M&M hardware $26.1B→$58.9B; R&M $66.8B→$172.6B. The ~10× spread = no settled "edge AI" definition; always pin the slice.
`,
  },
  {
    path: 'Knowledge/Kristi/reference/demand-side-method.md',
    id: 'c_kristidsm1',
    title: 'Demand-side method — deriving persona / ICP / UCP per lane',
    tags: ['persona', 'icp', 'ucp', 'demand-side', 'swimlane', 'method'],
    sources: ['https://www.pugetsystems.com', 'https://www.ansys.com', 'https://aecmag.com'],
    body: `
${PROVENANCE}

This note is METHOD, not pre-filled answers. The actual per-lane profiles are YOUR runtime output (\`derive_swimlane_profiles\` / \`record_swimlane_profile\`), grounded in the recorded envelope + these cues.

## The grounding chain (derive every profile BACKWARDS along it)
real workflow's **compute demand** → the **capability driver** that makes THIS lane the right envelope → the **buyer**. Put the workflow in \`grounded_on\`, the spec in \`capability_drivers\`. A persona you can't tie to a workflow's compute demand is a GUESS — mark it low-confidence with a falsifier.

## Bottleneck → persona cues (entry points, not a closed list)
- **clock-bound single-thread** (CAD modeling: SOLIDWORKS/Creo/NX/Revit editor) → a modeling/BIM-author SEAT in an entry-to-mid lane; one pro GPU; GeForce often *blocked* by cert.
- **multi-core + RAM solver** (implicit FEA, CPU sparse-direct) → an analyst/simulation seat in a mid-high+ lane; ECC capacity is the driver.
- **GPU-compute + VRAM cliff** (CFD/FEA GPU solvers, M&E GPU render) → render/solver seat; VRAM capacity at the required tier is the driver; multi-GPU only if the engine scales (render yes, training needs NVLink).
- **VRAM capacity + inference stack** (local LLM / agentic dev) → an ML/AI-dev seat; classify the box by usable-inference-capacity + CUDA-vs-ROCm-vs-MLX, and decide tower vs local_ai_appliance vs deskside_ai_server.
- **reality capture / huge-RAM + NVMe** → an AEC capture seat; storage IO + RAM are the drivers.
- **fixed-function decode density** (surveillance/broadcast analytics) → an analytics-server seat; NVENC/NVDEC engine count + 4:2:2 is the driver, often before tensor cores.

## ICP cues
Map the persona to the org: segment (smb/prosumer/enterprise/edu/gov), seat count, refresh cadence, and which ISV licenses they hold (the GPU-mode/solver gates). The org that has the *workflow that justifies the envelope* is the ICP.

## UCP cues (the honest, vendor-won't-say-it call)
- **over-buyer** — a workflow whose demand fits a lighter lane reaching for a heavier envelope (e.g. a viewport-only CAD seat buying the expert multi-GPU lane); disqualifier = the spec they'd waste; redirect DOWN a lane.
- **under-buyer** — a solver/VRAM/training workload landing in too light a lane (it'll thrash/starve); redirect UP a lane or to rack/edge-AI.
- **wrong-class** — a mobile/field workflow buying desktop, or an agentic-inference workload that belongs in edge-AI/local_ai_appliance not a tower.
- **A UCP without a real redirect lane is a complaint, not analysis** — always name the lane they belong in.

## The lenses to apply per lane
GeForce-vs-pro (does the ISV stack permit consumer GPUs), which OEM wins the seat (from \`hp_z_gaps\`), and the counter-positioning question (does an AMD/Intel/Apple path actually serve this seat, or is it CUDA/cert-locked).
`,
  },
];

let written = 0;
for (const n of notes) {
  const abs = resolve(VAULT, n.path);
  mkdirSync(dirname(abs), { recursive: true });
  const fm =
    `---\n` +
    `type: clipping\n` +
    `id: ${n.id}\n` +
    `kind: text\n` +
    `source: file\n` +
    `title: ${JSON.stringify(n.title)}\n` +
    `captured_at: ${CAPTURED}\n` +
    `reviewed: true\n` +
    `specialist_scope: kristi\n` +
    `tags: [${n.tags.join(', ')}]\n` +
    `---\n`;
  const sources = n.sources.length ? `\n\n## Source radar (verify specifics here)\n${n.sources.map((s) => `- ${s}`).join('\n')}` : '';
  writeFileSync(abs, `${fm}\n# ${n.title}\n${n.body.trimEnd()}${sources}\n`, 'utf8');
  console.log(`  + ${n.path}`);
  written++;
}
console.log(`\nSeeded ${written} clipping notes (specialist_scope: kristi) into ${VAULT}/Knowledge/Kristi/reference/.`);
