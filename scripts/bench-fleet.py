#!/usr/bin/env python3
"""Ad-hoc fleet inference benchmark (not committed; runs on the LLM host).

Measures, per (endpoint, model):
  - latency: TTFT + total + decode tok/s (streaming, single stream)
  - toolcall: % of runs that emit a VALID tool call on a prompt that demands one
  - json: % of runs that emit parseable JSON matching a required envelope
  - (optional) concurrency aggregate tok/s at N parallel streams

Usage:
  bench-fleet.py latency   <url> <model> [n_predict] [reps]
  bench-fleet.py toolcall  <url> <model> [reps]
  bench-fleet.py json      <url> <model> [reps]
  bench-fleet.py conc      <url> <model> [N] [n_predict]
  bench-fleet.py all       <url> <model>
"""
import sys, json, time, os, urllib.request, urllib.error, concurrent.futures, re

# THINK env: "0" => enable_thinking false (interactive default), "1" => true, "" => omit
_THINK = os.environ.get("THINK", "0")
def _think(body):
    if _THINK == "0": body["chat_template_kwargs"] = {"enable_thinking": False}
    elif _THINK == "1": body["chat_template_kwargs"] = {"enable_thinking": True}
    return body

def _post_stream(url, body, timeout=240):
    _think(body)
    req = urllib.request.Request(url.rstrip('/') + '/chat/completions',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    t0 = time.time(); ttft = None; toks = 0; buf = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data:'): continue
            data = line[5:].strip()
            if data == '[DONE]': break
            try: obj = json.loads(data)
            except: continue
            delta = obj.get('choices', [{}])[0].get('delta', {})
            piece = delta.get('content') or ''
            if piece:
                if ttft is None: ttft = time.time() - t0
                toks += 1; buf.append(piece)
    total = time.time() - t0
    return ttft, total, toks, ''.join(buf)

def _post(url, body, timeout=240):
    _think(body)
    req = urllib.request.Request(url.rstrip('/') + '/chat/completions',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        obj = json.loads(r.read().decode('utf-8', 'replace'))
    return time.time() - t0, obj

def latency(url, model, n_predict=200, reps=3):
    prompt = "In two sentences, what is the capital of France and why is it notable?"
    res = []
    for i in range(reps):
        body = {"model": model, "messages": [{"role":"user","content":prompt}],
                "max_tokens": int(n_predict), "temperature": 0.4, "stream": True}
        try:
            ttft, total, toks, txt = _post_stream(url, body)
            tps = toks/(total-ttft) if (ttft and total>ttft and toks>1) else 0
            res.append((ttft, total, toks, tps))
            print(f"  run{i+1}: ttft={ttft:.2f}s total={total:.2f}s out_toks~{toks} decode={tps:.1f}t/s")
        except Exception as e:
            print(f"  run{i+1}: ERROR {e}")
    if res:
        import statistics as st
        print(f"  >> median ttft={st.median(r[0] for r in res):.2f}s "
              f"decode={st.median(r[3] for r in res):.1f}t/s (n={len(res)})")

SYS_TOOL = ("You are Iris, an EV trip-planning specialist for a household assistant. "
    "You have tools. When a question needs live data, CALL A TOOL — never guess values. "
    "Do not narrate that you will search; emit the tool call.")
TOOLS = [
 {"type":"function","function":{"name":"ha_get_state","description":"Get the current state of a Home Assistant entity (e.g. the car's battery level).",
   "parameters":{"type":"object","properties":{"entity_id":{"type":"string","description":"HA entity id, e.g. sensor.ioniq_battery"}},"required":["entity_id"]}}},
 {"type":"function","function":{"name":"web_search","description":"Search the web for current information.",
   "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
 {"type":"function","function":{"name":"geocode","description":"Resolve an address or place name to coordinates.",
   "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
]
def _extract_tool_calls(msg, content):
    calls = msg.get('tool_calls') or []
    if calls:
        out=[]
        for c in calls:
            fn=c.get('function',{})
            args=fn.get('arguments')
            try: args=json.loads(args) if isinstance(args,str) else args
            except: pass
            out.append((fn.get('name'), args))
        return out, 'native'
    # content-embedded dialects
    m = re.search(r'<tool_call>\s*(\{.*?\})\s*</tool_call>', content or '', re.S)
    if m:
        try:
            o=json.loads(m.group(1)); return [(o.get('name'), o.get('arguments'))],'xml'
        except: return [('<unparseable_xml>',None)],'xml'
    if re.search(r'<tool_code>|<parameter=', content or ''):
        return [('<tool_code_dialect>',None)],'dialect'
    return [], 'none'

def toolcall(url, model, reps=8):
    prompt = "What's the current battery level of my Ioniq 5? Its HA entity is sensor.ioniq5_battery."
    ok=0; narrated=0; rows=[]
    for i in range(reps):
        body={"model":model,"messages":[{"role":"system","content":SYS_TOOL},{"role":"user","content":prompt}],
              "tools":TOOLS,"tool_choice":"auto","temperature":0.4,"max_tokens":400}
        try:
            dt,obj=_post(url,body)
            msg=obj.get('choices',[{}])[0].get('message',{})
            content=msg.get('content') or ''
            calls,kind=_extract_tool_calls(msg,content)
            valid = any(n and not n.startswith('<') and isinstance(a,dict) for n,a in calls)
            if valid:
                ok+=1; rows.append(f"  run{i+1}: TOOL_CALL[{kind}] {calls[0][0]}({calls[0][1]}) {dt:.1f}s")
            elif calls:
                rows.append(f"  run{i+1}: PARTIAL[{kind}] {calls} {dt:.1f}s")
            else:
                narrated+=1; rows.append(f"  run{i+1}: NO_CALL/narrated: {content[:90]!r} {dt:.1f}s")
        except Exception as e:
            rows.append(f"  run{i+1}: ERROR {e}")
    print('\n'.join(rows))
    print(f"  >> valid tool-call rate: {ok}/{reps}  ({100*ok//reps}%)  narrated={narrated}")

JSON_SYS=("You output ONLY a JSON object, no prose, no markdown fences. "
  "Schema: {\"summary\": string, \"priority\": one of [low,medium,high], \"action_items\": string[]}")
def json_test(url, model, reps=8, maxtok=500):
    prompt=("Three things happened today: the car charge dropped to 18%, a vet bill of $284 arrived, "
            "and a concert was announced for Friday. Summarize and prioritize as JSON per the schema.")
    ok=0; rows=[]; ts=[]
    for i in range(reps):
        body={"model":model,"messages":[{"role":"system","content":JSON_SYS},{"role":"user","content":prompt}],
              "temperature":0.3,"max_tokens":int(maxtok)}
        try:
            dt,obj=_post(url,body); ts.append(dt)
            msg=obj.get('choices',[{}])[0].get('message',{})
            content=msg.get('content') or ''
            rc=msg.get('reasoning_content') or ''
            usage=obj.get('usage',{})
            # strip think + fences
            c=re.sub(r'<think>.*?</think>','',content,flags=re.S).strip()
            c=re.sub(r'^```(json)?|```$','',c,flags=re.M).strip()
            m=re.search(r'\{.*\}',c,re.S)
            parsed=None
            if m:
                try: parsed=json.loads(m.group(0))
                except: pass
            good = isinstance(parsed,dict) and 'summary' in parsed and parsed.get('priority') in ('low','medium','high') and isinstance(parsed.get('action_items'),list)
            ct=usage.get('completion_tokens')
            if good: ok+=1; rows.append(f"  run{i+1}: OK prio={parsed['priority']} items={len(parsed['action_items'])} {dt:.1f}s out_tok={ct} think_chars={len(rc)}")
            else: rows.append(f"  run{i+1}: BAD {dt:.1f}s out_tok={ct} think_chars={len(rc)} head={(content[:70] or '<empty>')!r}")
        except Exception as e:
            rows.append(f"  run{i+1}: ERROR {e}")
    import statistics as st
    print('\n'.join(rows))
    print(f"  >> valid JSON rate: {ok}/{reps} ({100*ok//reps}%)  median_latency={st.median(ts):.1f}s" if ts else "  >> no runs")

CHAT_SYS=("You are Iris, an EV/logistics specialist. Use a tool when the question needs live or looked-up "
  "data; answer directly from general knowledge when it does not. Never invent tool results.")
BIGTOOLS=[
 {"type":"function","function":{"name":n,"description":d,"parameters":{"type":"object","properties":p,"required":r}}}
 for (n,d,p,r) in [
  ("ha_get_state","Current state of a Home Assistant entity.",{"entity_id":{"type":"string"}},["entity_id"]),
  ("ha_list_entities","List Home Assistant entities matching a domain.",{"domain":{"type":"string"}},["domain"]),
  ("web_search","Search the web for current info.",{"query":{"type":"string"}},["query"]),
  ("web_fetch_clean","Fetch a URL as clean markdown.",{"url":{"type":"string"}},["url"]),
  ("geocode","Resolve a place/address to coordinates.",{"query":{"type":"string"}},["query"]),
  ("route","Driving route between two places.",{"origin":{"type":"string"},"dest":{"type":"string"}},["origin","dest"]),
  ("distance_matrix","Distances among many points.",{"points":{"type":"array","items":{"type":"string"}}},["points"]),
  ("nearby","Find places near a location.",{"query":{"type":"string"},"near":{"type":"string"}},["query","near"]),
  ("caldav_upcoming","Upcoming calendar events.",{"days":{"type":"integer"}},["days"]),
  ("read_note","Read a vault note by path.",{"path":{"type":"string"}},["path"]),
  ("search_library","Full-text search the user's library.",{"query":{"type":"string"}},["query"]),
  ("weather_forecast","Weather forecast for a location.",{"location":{"type":"string"}},["location"]),
 ]]
def _calls_of(msg,content):
    cs,kind=_extract_tool_calls(msg,content);
    return [(n,a) for n,a in cs], kind
def toolhard(url, model, reps=4):
    # (label, user, expect): expect = tool name, or "NONE" for must-not-call
    cases=[
      ("select-among-12","How far is it to drive from Pleasantville to Denver?","route"),
      ("negative-general","Roughly how many miles are in a kilometer?","NONE"),
      ("argsynth-context","I'm at the office and want coffee within walking distance. Find some.","nearby"),
      ("calendar","What's on my calendar for the next 3 days?","caldav_upcoming"),
      ("weather","Will it rain in Pleasantville tomorrow?","weather_forecast"),
      ("negative-opinion","Should I buy an EV or a hybrid? Just your take.","NONE"),
    ]
    print(f"  (12 tools available; reps={reps} each)")
    tot=0; good=0
    for label,user,expect in cases:
        ok=0
        for _ in range(reps):
            body={"model":model,"messages":[{"role":"system","content":CHAT_SYS},{"role":"user","content":user}],
                  "tools":BIGTOOLS,"tool_choice":"auto","temperature":0.4,"max_tokens":400}
            try:
                dt,obj=_post(url,body); msg=obj.get('choices',[{}])[0].get('message',{}); content=msg.get('content') or ''
                calls,kind=_calls_of(msg,content)
                names=[n for n,a in calls if n and not n.startswith('<')]
                if expect=="NONE":
                    if not calls: ok+=1
                else:
                    if names and names[0]==expect and isinstance(calls[0][1],dict): ok+=1
            except Exception as e:
                pass
        tot+=reps; good+=ok
        verdict="✓" if ok==reps else ("~" if ok>0 else "✗")
        print(f"    {verdict} {label:18s} expect={expect:16s} {ok}/{reps}")
    print(f"  >> hard tool battery: {good}/{tot} ({100*good//tot}%)")

def conc(url, model, N=4, n_predict=200):
    prompt="Write a detailed paragraph about the history of coffee cultivation."
    def one(_):
        body={"model":model,"messages":[{"role":"user","content":prompt}],"max_tokens":int(n_predict),"temperature":0.7,"stream":True}
        return _post_stream(url,body)
    t0=time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as ex:
        rs=list(ex.map(one,range(N)))
    wall=time.time()-t0
    tot_toks=sum(r[2] for r in rs)
    per=[ (r[2]/(r[1]-r[0])) for r in rs if r[0] and r[1]>r[0] and r[2]>1 ]
    med=sorted(per)[len(per)//2] if per else 0
    print(f"  N={N}: wall={wall:.2f}s total_out_toks~{tot_toks} aggregate~{tot_toks/wall:.1f}t/s "
          f"per-stream median decode={med:.1f}t/s")

if __name__=='__main__':
    cmd=sys.argv[1]; url=sys.argv[2]; model=sys.argv[3]; rest=[int(x) for x in sys.argv[4:]]
    if cmd=='latency': latency(url,model,*rest)
    elif cmd=='toolcall': toolcall(url,model,*rest)
    elif cmd=='json': json_test(url,model,*rest)
    elif cmd=='conc': conc(url,model,*rest)
    elif cmd=='toolhard': toolhard(url,model,*rest)
    elif cmd=='all':
        print("[latency]"); latency(url,model)
        print("[toolcall]"); toolcall(url,model)
        print("[json]"); json_test(url,model)
        print("[concurrency N=4]"); conc(url,model,4)
