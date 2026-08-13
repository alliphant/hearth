#!/usr/bin/env python3
"""Voice-loop latency probe: TTS first-byte + STT transcription. Runs on the LLM host."""
import json, time, urllib.request, io

TTS="http://192.168.0.188:8023/v1/audio/speech"
STT="http://localhost:8093/v1/audio/transcriptions"
SENT="What's the battery level on the car right now, and do I need to charge before my morning drive?"

def tts():
    body={"model":"EN_F_Laur","voice":"EN_F_Laur","input":SENT,"response_format":"wav","stream":True}
    req=urllib.request.Request(TTS,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
    t0=time.time(); first=None; buf=io.BytesIO()
    with urllib.request.urlopen(req,timeout=60) as r:
        while True:
            chunk=r.read(4096)
            if not chunk: break
            if first is None: first=time.time()-t0
            buf.write(chunk)
    total=time.time()-t0; data=buf.getvalue()
    print(f"  TTS: first_byte={first:.2f}s total={total:.2f}s bytes={len(data)} sentence_words={len(SENT.split())}")
    return data

def stt(wav):
    # multipart
    boundary="----bench"; CRLF="\r\n"
    parts=[]
    parts.append(f"--{boundary}{CRLF}Content-Disposition: form-data; name=\"model\"{CRLF}{CRLF}deepdml/faster-whisper-large-v3-turbo-ct2{CRLF}")
    parts.append(f"--{boundary}{CRLF}Content-Disposition: form-data; name=\"file\"; filename=\"a.wav\"{CRLF}Content-Type: audio/wav{CRLF}{CRLF}")
    body=b"".join(p.encode() for p in parts)+wav+f"{CRLF}--{boundary}--{CRLF}".encode()
    req=urllib.request.Request(STT,data=body,headers={"Content-Type":f"multipart/form-data; boundary={boundary}"})
    t0=time.time()
    with urllib.request.urlopen(req,timeout=60) as r:
        out=json.loads(r.read())
    dt=time.time()-t0
    print(f"  STT: {dt:.2f}s text={out.get('text','')[:80]!r}")
    return dt

if __name__=="__main__":
    print("[voice round-trip x3]")
    for i in range(3):
        print(f"-- run {i+1} --")
        try:
            wav=tts(); stt(wav)
        except Exception as e:
            print(f"  ERROR {e}")
