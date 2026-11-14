"""Benchmark authorized audio + reference notes with the exact desktop worker.

Run using the isolated score Python environment; see docs/SCORES.md.
This does not download models or accept model access terms.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]

def sha256(file):
    digest=hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda:stream.read(4*1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()

def accuracy(predicted,reference):
    # Maximum bipartite matching avoids counting a reference note twice.
    candidates=[]
    for actual in predicted:
        candidates.append([i for i,target in enumerate(reference)
            if actual['pitch']==target['pitch'] and ('instrument' not in target or actual['instrument']==target['instrument'])
            and abs(actual['start']-target['start'])<=.05
            and abs(actual['end']-target['end'])<=max(.05,.2*(target['end']-target['start']))])
    matched={}
    def assign(index,seen):
        for target in candidates[index]:
            if target in seen:continue
            seen.add(target)
            if target not in matched or assign(matched[target],seen):matched[target]=index;return True
        return False
    correct=sum(assign(i,set()) for i in range(len(predicted)))
    precision=correct/len(predicted) if predicted else 0
    recall=correct/len(reference) if reference else 0
    return dict(truePositive=correct,falsePositive=len(predicted)-correct,falseNegative=len(reference)-correct,
                precision=precision,recall=recall,f1=2*precision*recall/(precision+recall) if precision+recall else 0)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cases',type=Path,required=True)
    parser.add_argument('--weights',type=Path,required=True,help='Official model.safetensors with adjacent config.json')
    parser.add_argument('--model',choices=['small','medium','large'],required=True)
    parser.add_argument('--beat-checkpoint',type=Path,required=True)
    parser.add_argument('--device',choices=['cpu','cuda','mps'],default='cpu')
    parser.add_argument('--ffmpeg',default='ffmpeg')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    manifest=json.loads((ROOT/'resources/score-runtime/models.json').read_text(encoding='utf-8'))[args.model]
    if sha256(args.weights)!=manifest['sha256']:raise ValueError('Weights do not match the pinned desktop model')
    beat=json.loads((ROOT/'resources/beat-this/manifest.json').read_text(encoding='utf-8'))['model']
    if sha256(args.beat_checkpoint)!=beat['sha256']:raise ValueError('Beat This checkpoint checksum mismatch')
    cases=json.loads(args.cases.read_text(encoding='utf-8'))
    args.output.mkdir(parents=True,exist_ok=True); results=[]
    import soundfile as sf
    for index,case in enumerate(cases):
        if not case.get('license'):raise ValueError('Each case needs its audio-use license/provenance')
        original=(args.cases.parent/case['file']).resolve()
        folder=args.output/f'{index+1:02d}-{args.model}-{args.device}'
        folder.mkdir(parents=True,exist_ok=True)
        audio=folder/'audio.wav'; beats=folder/'beat.wav'; started=time.perf_counter()
        for target,sample_rate in [(audio,16000),(beats,22050)]:
            subprocess.run([args.ffmpeg,'-y','-v','error','-i',str(original),'-vn','-ar',str(sample_rate),'-ac','1','-c:a','pcm_f32le',str(target)],check=True)
        duration=sf.info(audio).duration
        request=dict(mode='infer',model=args.model,device=args.device,weights=str(args.weights.resolve()),beatAudio=str(beats.resolve()),
            beatCheckpoint=str(args.beat_checkpoint.resolve()),settings={},sources=[dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL,sha256(original))),name=case['title'],audio=str(audio.resolve()),duration=duration,stemType=case.get('stemType',''))])
        request_file=folder/'request.json';request_file.write_text(json.dumps(request),encoding='utf-8')
        with (folder/'worker.jsonl').open('w',encoding='utf-8') as log,(folder/'worker.stderr').open('w',encoding='utf-8') as errors:
            process=subprocess.run([sys.executable,str(ROOT/'python/worker/score_worker.py'),'--request',str(request_file),'--out',str(folder/'result')],stdout=log,stderr=errors)
        row=dict(title=case['title'],license=case['license'],sha256=sha256(original),model=args.model,device=args.device,duration=duration,totalSeconds=time.perf_counter()-started,success=process.returncode==0)
        if process.returncode==0:
            data=json.loads((folder/'result/score.json').read_text(encoding='utf-8')); row.update(data['metrics'])
            predicted=[dict(n,instrument=t['instrument']) for t in data['tracks'] for n in t['notes']]
            row['noteCount']=len(predicted)
            if case.get('reference') is not None:row['accuracy']=accuracy(predicted,case['reference'])
        results.append(row)
        (args.output/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(row,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
