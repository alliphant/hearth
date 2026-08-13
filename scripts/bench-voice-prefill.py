#!/usr/bin/env python3
"""Measure 9B TTFT as a function of voice system-prompt size, using Kate's REAL
persona + voice_style. Quantifies the prefill cost of her full persona vs a slim
voice persona. Runs on the LLM host against :8088."""
import json, time, urllib.request, sys, re

URL="http://localhost:8088/v1/chat/completions"
MODEL="Qwen3.5-9B-Q8_0.gguf"
KATE="/docker/hearth/repo/config/specialists/kate.yaml"

import yaml
d=yaml.safe_load(open(KATE))
persona=(d.get('persona') or '').replace('{{user_name}}','Jasper')
voice_style=(d.get('voice_style') or '').replace('{{user_name}}','Jasper')

SCAFFOLD=("\n\nYou are speaking with Jasper (owner). Right now (for your own awareness, "
  "don't say it unless asked): Saturday evening.\n\nDon't fabricate — if a fact isn't "
  "in front of you, call the tool that resolves it or say you'll check.")

# The CURRENT voice prompt: full persona + voice_style + scaffold
full_prompt = persona + "\n\n" + voice_style + SCAFFOLD
# A SLIM voice persona proxy (~what a condensed Kate voice chunk would be):
slim_persona=("You are Kate, Jasper's warm, sharp chief of staff. Speak like a trusted "
  "human assistant on the phone: brief, natural, direct. You coordinate a team of "
  "specialists and can consult them. Acknowledge first, then act. If you don't know "
  "a live fact, say you'll check rather than guess.")
slim_prompt = slim_persona + "\n\n" + voice_style + SCAFFOLD
tiny_prompt = slim_persona + SCAFFOLD

def est_tok(s): return len(s)//4

def ttft(system, reps=4, cold=False):
    res=[]
    for i in range(reps):
        # cold: prepend a unique nonce so the KV-cache prefix never matches → true prefill cost
        sysp = (f"[ref {time.time()}_{i}] " + system) if cold else system
        body={"model":MODEL,"messages":[{"role":"system","content":sysp},
              {"role":"user","content":"Hey Kate, what's going on today?"}],
              "max_tokens":40,"temperature":0.4,"stream":True,
              "chat_template_kwargs":{"enable_thinking":False}}
        req=urllib.request.Request(URL,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
        t0=time.time(); first=None
        with urllib.request.urlopen(req,timeout=60) as r:
            for raw in r:
                line=raw.decode('utf-8','replace').strip()
                if not line.startswith('data:'): continue
                dt=line[5:].strip()
                if dt=='[DONE]': break
                try: o=json.loads(dt)
                except: continue
                if o.get('choices',[{}])[0].get('delta',{}).get('content'):
                    first=time.time()-t0; break
        if first: res.append(first)
    res.sort()
    return res[len(res)//2] if res else None

print(f"persona: {len(persona)} chars (~{est_tok(persona)} tok)")
print(f"voice_style: {len(voice_style)} chars (~{est_tok(voice_style)} tok)")
print()
print(f"{'prompt':42s} {'sys_tok':>7s}  {'COLD(re-prefill)':>16s}  {'WARM(cached)':>13s}")
for label, p in [("FULL (persona+voice_style+scaffold)", full_prompt),
                 ("SLIM (condensed voice persona)", slim_prompt),
                 ("TINY (1-para persona, no voice_style)", tiny_prompt)]:
    cold=ttft(p, reps=5, cold=True)     # nonce-busted → true full prefill cost
    ttft(p, reps=1)                      # warm the slot
    warm=ttft(p, reps=4, cold=False)     # identical prefix → cache hit
    print(f"{label:42s} {est_tok(p):7d}  {cold:16.3f}  {warm:13.3f}")
