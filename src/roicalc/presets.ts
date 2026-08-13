// src/roicalc/presets.ts — convenience defaults for the calculator's GPU
// picker. These are editable street-price ballparks, not authority: prices
// drift, and the UI lets the user override every number. Watts are
// whole-system inference draw / idle (GPU + host overhead); for the
// unified-memory boxes (Spark, Mac) the preset IS the whole system, so the
// "rest of system" field belongs at 0.

export interface GpuPreset {
  id: string;
  label: string;
  price_usd: number;
  load_w: number;
  idle_w: number;
  vram_gb: number;
}

export const GPU_PRESETS: GpuPreset[] = [
  { id: 'hp_z8_fury_rtx6000ada', label: 'workstation-class machine (refurb) + RTX 6000 Ada 48GB', price_usd: 8700, load_w: 550, idle_w: 150, vram_gb: 48 },
  { id: 'rtx3090', label: 'RTX 3090 24GB (used)', price_usd: 750, load_w: 380, idle_w: 55, vram_gb: 24 },
  { id: 'rtx4090', label: 'RTX 4090 24GB', price_usd: 1700, load_w: 430, idle_w: 50, vram_gb: 24 },
  { id: 'rtx5090', label: 'RTX 5090 32GB', price_usd: 2300, load_w: 560, idle_w: 55, vram_gb: 32 },
  { id: 'rtx4000_sff', label: 'RTX 4000-class SFF 24GB', price_usd: 1500, load_w: 200, idle_w: 40, vram_gb: 24 },
  { id: 'rtx6000_ada', label: 'RTX 6000 Ada 48GB', price_usd: 5200, load_w: 350, idle_w: 60, vram_gb: 48 },
  { id: 'rtxpro6000_blackwell', label: 'RTX PRO 6000 Blackwell 96GB', price_usd: 8500, load_w: 650, idle_w: 70, vram_gb: 96 },
  { id: 'dgx_spark', label: 'DGX Spark (GB10, 128GB unified)', price_usd: 4000, load_w: 200, idle_w: 45, vram_gb: 128 },
  { id: 'mac_studio_m4max', label: 'Mac Studio M4 Max 128GB', price_usd: 3700, load_w: 180, idle_w: 15, vram_gb: 128 },
];
