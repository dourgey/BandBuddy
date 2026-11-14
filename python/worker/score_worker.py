"""Local transcription adapter. Rendering/export never imports Torch or downloads files."""
from __future__ import annotations
import argparse
import bisect
import copy
import hashlib
import json
import math
import statistics
import struct
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

REVISION = '8a1ef88672cc23c26619adaff37ec48d82c0b906'
PROGRAMS = dict(zip(
    ['acoustic_piano','electric_piano','chromatic_percussion','organ','acoustic_guitar',
     'clean_electric_guitar','distorted_electric_guitar','acoustic_bass','electric_bass',
     'slap_bass','synth_bass','violin','viola','cello','contrabass','harp','timpani',
     'string_ensemble','synth_strings','voice','trumpet','trombone','tuba','french_horn',
     'brass_section','soprano_and_alto_sax','tenor_sax','baritone_sax','oboe',
     'english_horn','bassoon','clarinet','flutes','synth_lead','synth_pad'],
    [0,4,8,16,24,26,29,32,33,36,38,40,41,42,43,46,47,48,50,52,56,57,58,60,61,64,66,67,68,69,70,71,73,80,88]))
TUNINGS = {'guitar': ([40,45,50,55,59,64],22), 'drop-d': ([38,45,50,55,59,64],22),
           'bass': ([28,33,38,43],24), 'bass-5': ([23,28,33,38,43],24)}
INSTRUMENT_LABELS = {'acoustic_piano':'钢琴','electric_piano':'电钢琴','acoustic_guitar':'原声吉他',
    'clean_electric_guitar':'清音电吉他','distorted_electric_guitar':'失真电吉他','acoustic_bass':'原声贝斯',
    'electric_bass':'电贝斯','voice':'人声','drums':'鼓组','organ':'管风琴','violin':'小提琴','viola':'中提琴',
    'cello':'大提琴','contrabass':'低音提琴','orchestral_harp':'竖琴','string_ensemble':'弦乐组',
    'synth_strings':'合成弦乐','synth_lead':'合成器主音','synth_pad':'合成器铺底','chromatic_percussion':'有音高打击乐'}

def emit(**message):
    print(json.dumps(message, ensure_ascii=False, allow_nan=False), flush=True)

def interpolate(value, points, source='time', target='beat'):
    if len(points) < 2:
        raise ValueError('INVALID_TEMPO_MAP')
    lo, hi = 0, len(points)-1
    while lo + 1 < hi:
        mid = (lo+hi)//2
        if points[mid][source] <= value: lo = mid
        else: hi = mid
    a,b = points[lo],points[hi]
    return a[target] + (value-a[source])*(b[target]-a[target])/(b[source]-a[source])

def default_tempo(duration):
    return dict(points=[dict(time=0.,beat=0.),dict(time=max(1.,duration),beat=max(1.,duration)*2)],
                bpm=120., numerator=4, denominator=4, firstDownbeat=0., provisional=True)

def prepare(data, settings):
    data = copy.deepcopy(data)
    # A new engraving revision must not retain old fingering/notation failures.
    data['inferenceWarnings'] = list(data.get('inferenceWarnings', data.get('warnings', [])))
    data['warnings'] = list(data['inferenceWarnings'])
    detected = copy.deepcopy(data.get('detectedTempo', data['tempo']))
    data['detectedTempo'] = detected
    tempo = copy.deepcopy(detected)
    numerator = settings.get('numerator') or tempo['numerator']
    denominator = settings.get('denominator',4) if settings.get('numerator') else tempo['denominator']
    bar = numerator*4/denominator
    first = settings.get('firstDownbeat')
    first = tempo['firstDownbeat'] if first is None else first
    bpm = settings.get('bpm')
    if bpm is not None:
        tempo['points'] = [dict(time=0.,beat=-first*bpm/60),dict(time=max(1.,data['duration']),beat=(max(1.,data['duration'])-first)*bpm/60)]
        tempo['bpm'] = bpm
        tempo['provisional'] = False
        data['warnings'] = [warning.replace('使用临时 120 BPM 网格', '已使用手动记谱网格') for warning in data['warnings']]
    else:
        offset = interpolate(first, tempo['points'])
        tempo['points'] = [dict(time=p['time'],beat=p['beat']-offset) for p in tempo['points']]
    initial = interpolate(0, tempo['points'])
    shift = math.ceil(max(0,-initial)/bar-1e-9)*bar
    for p in tempo['points']: p['beat'] += shift
    tempo.update(numerator=numerator,denominator=denominator,firstDownbeat=first)
    data['tempo'] = tempo
    subdivision = settings.get('subdivision',4)
    for track in data['tracks']:
        for n in track['notes']:
            n.pop('string',None); n.pop('fret',None)
            onset = max(0,round(interpolate(n['start'],tempo['points'])*subdivision)/subdivision)
            end = max(onset+1/subdivision,round(interpolate(n['end'],tempo['points'])*subdivision)/subdivision)
            n['beat'],n['durationBeats'] = onset,end-onset
        assign_tab(track,settings)
    return data

def assign_tab(track,settings):
    instrument = track['instrument']
    if 'guitar' not in instrument and 'bass' not in instrument or instrument in ('synth_bass','contrabass'):
        return
    tuning = settings.get('tunings',{}).get(track['id'],'bass' if 'bass' in instrument else 'guitar')
    opens,frets = TUNINGS[tuning]
    track['tuning'] = tuning
    # Bounded dynamic programming retains occupied strings across sustained notes.
    states = [(0.,0.,{}, None)]
    for note in sorted(track['notes'],key=lambda n:(n['beat'],-n['pitch'],n['id'])):
        candidates = [(len(opens)-i,note['pitch']-o) for i,o in enumerate(opens) if 0 <= note['pitch']-o <= frets]
        next_states = []
        for cost,position,active,history in states:
            active = {s:v for s,v in active.items() if v[0] > note['beat']+1e-8}
            valid = [(s,f) for s,f in candidates if s not in active]
            for string,fret in valid:
                sounding = [v[1] for v in active.values() if v[1]>0] + ([fret] if fret>0 else [])
                span = max(sounding)-min(sounding) if sounding else 0
                if span > 7: continue
                penalty = abs(fret-position)*.6 + fret*.08 + max(0,span-4)*12
                next_states.append((cost+penalty,float(fret or position),{**active,string:(note['beat']+note['durationBeats'],fret)}, (history,note['id'],(string,fret))))
            # Retain an explicit unassigned alternative, including impossible hand spans.
            next_states.append((cost+10000,position,active,(history,note['id'],None)))
        states = sorted(next_states,key=lambda s:s[0])[:16]
    assignments={}; history=states[0][3]
    while history is not None:
        history,note_id,value=history; assignments[note_id]=value
    for n in track['notes']:
        value = assignments.get(n['id'])
        if value: n['string'],n['fret'] = value

def channel_assignments(tracks):
    melodic=drum=0
    result=[]
    for t in tracks:
        if t['isDrum']:
            result.append((drum,9)); drum+=1
        else:
            port,ch=divmod(melodic,15); melodic+=1
            result.append((port,ch if ch<9 else ch+1))
    return result

def vlq(n):
    out=[n&127]
    while n>>7:
        n>>=7; out.insert(0,(n&127)|128)
    return bytes(out)

def midi_bytes(data, quantized=True):
    tempo=data['tempo']; points=tempo['points']; tracks=data['tracks']
    def chunk(tag,body): return tag+struct.pack('>I',len(body))+body
    def track_bytes(events,end_tick):
        previous=0; out=bytearray()
        for tick,order,msg in sorted(events,key=lambda e:(e[0],e[1])):
            out+=vlq(tick-previous)+msg; previous=tick
        out+=vlq(max(0,end_tick-previous))+b'\xff\x2f\0'
        return chunk(b'MTrk',out)
    offset=interpolate(0,points)
    end_tick=max(1,round((interpolate(data['duration'],points)-offset)*480))
    meta=[(0,0,bytes([255,88,4,tempo['numerator'],int(math.log2(tempo['denominator'])),24,8]))]
    for i,p in enumerate(points[:-1]):
        q=points[i+1]; us=round((q['time']-p['time'])/(q['beat']-p['beat'])*1e6)
        tick=0 if i==0 else max(0,round((p['beat']-offset)*480))
        meta.append((tick,0,b'\xff\x51\x03'+max(1,min(0xffffff,us)).to_bytes(3,'big')))
    marker=f'bandbuddy:audioOffsetBeats={offset:.9f}'.encode()
    meta.append((0,1,b'\xff\x06'+vlq(len(marker))+marker))
    chunks=[track_bytes(meta,end_tick)]
    for track,(port,ch) in zip(tracks,channel_assignments(tracks)):
        name=track['name'].encode('utf-8')
        events=[(0,-3,bytes([255,33,1,port])),(0,-2,b'\xff\x03'+vlq(len(name))+name),(0,-1,bytes([192|ch,track['program']]))]
        for n in track['notes']:
            onset=n['beat'] if quantized else interpolate(n['start'],points)
            end=onset+n['durationBeats'] if quantized else interpolate(n['end'],points)
            start_tick=max(0,round((onset-offset)*480)); stop_tick=max(start_tick+1,round((end-offset)*480))
            events.extend([(start_tick,1,bytes([144|ch,n['pitch'],n['velocity']])),(stop_tick,0,bytes([128|ch,n['pitch'],0]))])
        chunks.append(track_bytes(events,max(end_tick,max((e[0] for e in events),default=0))))
    return b'MThd'+struct.pack('>IHHH',6,1,len(chunks),480)+b''.join(chunks)

def element(parent,tag,text=None,**attrs):
    node=ET.SubElement(parent,tag,{k:str(v) for k,v in attrs.items()})
    if text is not None: node.text=str(text)
    return node

def duration_parts(ticks,triplet):
    values=[(1920,'whole',False,False),(1440,'half',True,False),(960,'half',False,False),(720,'quarter',True,False),
            (480,'quarter',False,False),(360,'eighth',True,False),(240,'eighth',False,False),(180,'16th',True,False),
            (120,'16th',False,False),(60,'32nd',False,False)]
    if triplet: values += [(640,'half',False,True),(320,'quarter',False,True),(160,'eighth',False,True),(80,'16th',False,True)]
    values.sort(reverse=True)
    while ticks>0:
        possible=[v for v in values if v[0]<=ticks and (not triplet or v[0]%80==0)]
        if not possible: raise ValueError(f'UNWRITABLE_DURATION:{ticks}')
        v=possible[0]; yield v; ticks-=v[0]

def voices(notes):
    grouped={}
    for n in notes: grouped.setdefault((round(n['beat']*480),round(n['durationBeats']*480)),[]).append(n)
    out=[]; ends=[]
    for (start,duration),chord in sorted(grouped.items()):
        available=next((i for i,end in enumerate(ends) if end<=start),len(ends))
        if available==len(ends): out.append([]); ends.append(0)
        out[available].append((start,duration,chord)); ends[available]=start+duration
    return out or [[]]

def musicxml(data,settings,tab=False,start_bar=0,bar_count=None):
    tempo=data['tempo']; bar_ticks=round(tempo['numerator']*4/tempo['denominator']*480)
    end=max([interpolate(data['duration'],tempo['points'])]+[n['beat']+n['durationBeats'] for t in data['tracks'] for n in t['notes']])
    total=max(1,math.ceil(end*480/bar_ticks)); stop=min(total,start_bar+bar_count) if bar_count else total
    start_bar=max(0,min(start_bar,total-1)); stop=max(start_bar+1,stop)
    root=ET.Element('score-partwise',version='4.0'); parts=element(root,'part-list')
    triplet=settings.get('subdivision',4) in (3,6)
    for ti,track in enumerate(data['tracks']):
        pid=f'P{ti+1}'; entry=element(parts,'score-part',id=pid); element(entry,'part-name',track['name'])
        inst=element(entry,'score-instrument',id=f'{pid}-I'); element(inst,'instrument-name',track['name'])
        if track['isDrum']:
            for pitch in sorted({n['pitch'] for n in track['notes']}):
                drum=element(entry,'score-instrument',id=f'{pid}-D{pitch}'); element(drum,'instrument-name',f'Drum {pitch}')
        port,channel=channel_assignments(data['tracks'])[ti]
        element(entry,'midi-device',port=port+1)
        midi=element(entry,'midi-instrument',id=f'{pid}-I'); element(midi,'midi-channel',channel+1); element(midi,'midi-program',track['program']+1)
        if track['isDrum']:
            for pitch in sorted({n['pitch'] for n in track['notes']}):
                mi=element(entry,'midi-instrument',id=f'{pid}-D{pitch}'); element(mi,'midi-channel',10); element(mi,'midi-unpitched',pitch+1)
        part=element(root,'part',id=pid)
        fretted='tuning' in track; show_tab=tab and fretted
        octave_transposing=fretted and all(n['pitch']<=119 for n in track['notes'])
        piano=track['instrument'] in ('acoustic_piano','electric_piano')
        staff_notes=[track['notes']] if not piano else [[n for n in track['notes'] if n['pitch']>=60],[n for n in track['notes'] if n['pitch']<60]]
        if show_tab: staff_notes.append(track['notes'])
        staff_voices=[voices(ns) for ns in staff_notes]
        starts=[[ [event[0] for event in events] for events in voice_list] for voice_list in staff_voices]
        for bar_index in range(start_bar,stop):
            measure=element(part,'measure',number=bar_index+1)
            attributes=element(measure,'attributes'); element(attributes,'divisions',480)
            if bar_index==start_bar:
                key=element(attributes,'key'); element(key,'fifths',0)
                meter=element(attributes,'time'); element(meter,'beats',tempo['numerator']); element(meter,'beat-type',tempo['denominator'])
                if len(staff_notes)>1: element(attributes,'staves',len(staff_notes))
                for staff in range(1,len(staff_notes)+1):
                    is_tab=show_tab and staff==len(staff_notes)
                    clef=element(attributes,'clef',number=staff)
                    bass=('bass' in track['instrument'] or track['instrument'] in ('cello','contrabass','bassoon','tuba') or piano and staff==2)
                    element(clef,'sign','TAB' if is_tab else 'percussion' if track['isDrum'] else 'F' if bass else 'G')
                    if not is_tab and not track['isDrum']:
                        element(clef,'line',4 if bass else 2)
                    if is_tab:
                        opens,_=TUNINGS[track['tuning']]; details=element(attributes,'staff-details',number=staff); element(details,'staff-lines',len(opens))
                        for line,open_pitch in enumerate(opens,1):
                            tuning=element(details,'staff-tuning',line=line); add_pitch(tuning,open_pitch,'tuning-')
                if octave_transposing:
                    transpose=element(attributes,'transpose',**({'number':1} if show_tab else {})); element(transpose,'diatonic',0); element(transpose,'chromatic',0); element(transpose,'octave-change',-1)
            bar_start=bar_index*bar_ticks; bar_end=bar_start+bar_ticks
            if ti==0:
                changes=[(0,60*(tempo['points'][1]['beat']-tempo['points'][0]['beat'])/(tempo['points'][1]['time']-tempo['points'][0]['time']))]
                for a,b in zip(tempo['points'],tempo['points'][1:]):
                    bpm=60*(b['beat']-a['beat'])/(b['time']-a['time'])
                    if abs(bpm-changes[-1][1])>.01: changes.append((round(a['beat']*480),bpm))
                if bar_index==start_bar and bar_start>0:
                    current=next((bpm for tick,bpm in reversed(changes) if tick<=bar_start),tempo['bpm'])
                    changes=[(bar_start,current)]+[(tick,bpm) for tick,bpm in changes if tick>bar_start]
                for tick,bpm in changes:
                    if bar_start<=tick<bar_end:
                        direction=element(measure,'direction',placement='above'); dtype=element(direction,'direction-type'); metronome=element(dtype,'metronome')
                        element(metronome,'beat-unit','quarter'); element(metronome,'per-minute',round(bpm,3)); element(direction,'offset',tick-bar_start); element(direction,'sound',tempo=round(bpm,6))
            stream=0
            for si,voice_list in enumerate(staff_voices,1):
                is_tab=show_tab and si==len(staff_notes)
                for vi,events in enumerate(voice_list,1):
                    if stream: back=element(measure,'backup'); element(back,'duration',bar_ticks)
                    stream+=1; cursor=bar_start
                    def write_span(start,end,chord=None,event_start=0,event_end=0):
                        position=start
                        for length,kind,dotted,tuplet in duration_parts(end-start,triplet):
                            # A rest cannot belong to a chord. Omit unassignable TAB
                            # heads and mark the segment, retaining every pitch on staff.
                            heads=[n for n in (chord or []) if not is_tab or 'string' in n]
                            omitted=bool(is_tab and chord and len(heads)!=len(chord))
                            for ni,n in enumerate(heads or [None]):
                                unplayable=bool(n and is_tab and 'string' not in n)
                                node=element(measure,'note',**({'id':f"n{n['id']}-{si}-{position}"} if n else {}))
                                if ni: element(node,'chord')
                                if n is None or unplayable: element(node,'rest')
                                elif track['isDrum']:
                                    unpitched=element(node,'unpitched'); element(unpitched,'display-step',{36:'F',38:'C',42:'G',46:'G',49:'A',51:'F'}.get(n['pitch'],'D')); element(unpitched,'display-octave',4 if n['pitch'] in (35,36) else 5)
                                else:
                                    p=element(node,'pitch'); add_pitch(p,n['pitch']+(12 if octave_transposing and not is_tab else 0))
                                element(node,'duration',length)
                                continuing=bool(n and position>event_start); continued=bool(n and position+length<event_end)
                                if continuing and not unplayable: element(node,'tie',type='stop')
                                if continued and not unplayable: element(node,'tie',type='start')
                                if n and track['isDrum']: element(node,'instrument',id=f"{pid}-D{n['pitch']}")
                                element(node,'voice',(si-1)*100+vi); element(node,'type',kind)
                                if dotted: element(node,'dot')
                                if tuplet:
                                    mod=element(node,'time-modification'); element(mod,'actual-notes',3); element(mod,'normal-notes',2)
                                if len(staff_notes)>1: element(node,'staff',si)
                                if n:
                                    notation=element(node,'notations')
                                    if continuing and not unplayable: element(notation,'tied',type='stop')
                                    if continued and not unplayable: element(notation,'tied',type='start')
                                    if is_tab and not unplayable:
                                        technical=element(notation,'technical'); element(technical,'string',n['string']); element(technical,'fret',n['fret'])
                                if omitted and ni==0:
                                    lyric=element(node,'lyric'); element(lyric,'text','指法待确认')
                            position+=length
                    first=max(0,bisect.bisect_right(starts[si-1][vi-1],bar_start)-1)
                    for start,duration,chord in events[first:]:
                        if start>=bar_end: break
                        a,b=max(start,bar_start),min(start+duration,bar_end)
                        if b<=a: continue
                        if a>cursor: write_span(cursor,a)
                        write_span(a,b,chord,start,start+duration); cursor=b
                    if cursor<bar_end: write_span(cursor,bar_end)
    return '<?xml version="1.0" encoding="utf-8"?>\n'+ET.tostring(root,encoding='unicode'), start_bar*bar_ticks/480,total

def add_pitch(parent,pitch,prefix=''):
    if not 12<=pitch<=131: raise ValueError(f'音高 {pitch} 超出 MusicXML 音域；原音高保留在 MIDI 与卷帘中')
    names=['C','C','D','E','E','F','F','G','A','A','B','B']; alter=[0,1,0,-1,0,0,1,0,-1,0,-1,0]
    element(parent,prefix+'step',names[pitch%12])
    if alter[pitch%12]: element(parent,prefix+'alter',alter[pitch%12])
    element(parent,prefix+'octave',pitch//12-1)

def infer(request):
    import os
    import platform
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
    import torch
    torch.set_num_threads(max(1,min(8,int(os.environ.get('BANDBUDDY_CPU_THREADS','4')))))
    from muscriptor import TranscriptionModel
    from muscriptor.events import NoteStartEvent,NoteEndEvent,ProgressEvent
    device=request.get('device','auto')
    if device=='auto': device='cuda' if torch.cuda.is_available() else 'mps' if platform.machine()=='arm64' and torch.backends.mps.is_available() else 'cpu'
    started=time.perf_counter()
    emit(type='progress',phase='加载转谱模型',progress=.02)
    model=TranscriptionModel.load_model(request['weights'],device=device)
    duration=max(s['duration'] for s in request['sources']); tracks=[]; warnings=[]
    tempo=default_tempo(duration)
    try:
        from beat_this.inference import Audio2Beats
        import soundfile as sf
        audio,sr=sf.read(request['beatAudio'],dtype='float32')
        tracker=Audio2Beats(checkpoint_path=request['beatCheckpoint'],device='cpu',dbn=False)
        beats,downbeats=tracker(audio,sr); beats=[float(v) for v in beats]; downbeats=[float(v) for v in downbeats]
        if len(beats)>=4:
            period=statistics.median(b-a for a,b in zip(beats,beats[1:])); meter=4
            if len(downbeats)>2:
                counts=[sum(a<=v<b for v in beats) for a,b in zip(downbeats,downbeats[1:])]
                inferred=statistics.mode(counts)
                if inferred in (2,3,4,5,6,7): meter=inferred
            first=downbeats[0] if downbeats else beats[0]
            tempo=dict(points=[dict(time=t,beat=float(i)) for i,t in enumerate(beats)],bpm=60/period,numerator=meter,denominator=4,firstDownbeat=first,provisional=not bool(downbeats))
        else: warnings.append('节拍不明确，请检查 BPM、拍号和首拍位置。')
    except Exception as error: warnings.append('节拍检测未完成，使用临时 120 BPM 网格：'+str(error)[:160])
    for index,source in enumerate(request['sources']):
        groups={}; open_notes={}
        stem=source.get('stemType','')
        allowed=None
        from muscriptor.tokenizer.mt3 import MT3_FULL_PLUS_GROUP_NAMES
        candidates=list(MT3_FULL_PLUS_GROUP_NAMES)
        if stem=='drums': allowed=['drums']
        elif 'guitar' in stem.lower(): allowed=[n for n in candidates if 'guitar' in n]
        elif stem=='bass': allowed=[n for n in candidates if 'bass' in n and n not in ('bassoon','contrabass')]
        elif stem=='piano': allowed=[n for n in candidates if 'piano' in n]
        elif stem in ('vocals','lead_vocals','backing_vocals'): allowed=['voice']
        for event in model.transcribe(source['audio'],instruments=allowed,batch_size=1,prelude_forcing=True):
            if isinstance(event,ProgressEvent): emit(type='progress',phase=f"转谱：{source['name']} · {event.completed}/{event.total}",progress=.08+.84*(index+event.completed/max(1,event.total))/len(request['sources']))
            elif isinstance(event,NoteStartEvent): open_notes[event.index]=event
            elif isinstance(event,NoteEndEvent):
                n=event.start_event; open_notes.pop(n.index,None)
                if not 0<=n.pitch<=127 or not math.isfinite(n.start_time) or not math.isfinite(event.end_time): continue
                a=max(0.,float(n.start_time)); b=min(source['duration'],max(a+.01,float(event.end_time)))
                if a>=duration or b<=a: continue
                track_id=hashlib.sha256(f"{source['id']}:{n.instrument}".encode()).hexdigest()[:24]
                if track_id not in groups:
                    program=next((p[0] for gid,p in model._tokenizer.group_program_map.items() if gid==MT3_FULL_PLUS_GROUP_NAMES.get(n.instrument) and p),PROGRAMS.get(n.instrument,0))
                    label=INSTRUMENT_LABELS.get(n.instrument,n.instrument.replace('_',' '))
                    groups[track_id]=dict(id=track_id,sourceId=source['id'],name=f"{source['name']} · {label}" if len(request['sources'])>1 or stem else label,instrument=n.instrument,program=max(0,min(127,program)),isDrum=n.instrument=='drums',notes=[])
                groups[track_id]['notes'].append(dict(id=f'{track_id}-{n.index}',pitch=n.pitch,start=a,end=b,velocity=100))
        for track in groups.values(): track['notes'].sort(key=lambda n:(n['start'],n['pitch'],n['end']))
        tracks.extend(groups.values())
    if not tracks: raise ValueError('未识别到音符，请尝试其他音频或模型。')
    import psutil
    memory=psutil.Process().memory_info()
    metrics=dict(elapsedSeconds=time.perf_counter()-started,device=device,peakResidentBytes=getattr(memory,'peak_wset',memory.rss),peakGpuBytes=torch.cuda.max_memory_allocated() if device=='cuda' else None)
    emit(type='metrics',**metrics)
    return dict(version=1,duration=duration,tracks=tracks,tempo=tempo,warnings=warnings,model=dict(revision=REVISION,size=request['model'],velocity='constant:100'),metrics=metrics)

def validate_data(data):
    if not 0<data['duration']<=1800 or len(data['tracks'])>128: raise ValueError('SCORE_LIMIT:音频最长 30 分钟，最多 128 轨')
    ids=set(); note_ids=set(); points=data['tempo']['points']
    if len(points)<2 or any(not math.isfinite(p[k]) for p in points for k in ('time','beat')) or any(b['time']<=a['time'] or b['beat']<=a['beat'] for a,b in zip(points,points[1:])): raise ValueError('INVALID_TEMPO_MAP')
    for t in data['tracks']:
        if t['id'] in ids: raise ValueError('DUPLICATE_TRACK')
        ids.add(t['id'])
        if len(t['notes'])>200000: raise ValueError('SCORE_NOTE_LIMIT')
        for n in t['notes']:
            if n['id'] in note_ids: raise ValueError('DUPLICATE_NOTE')
            note_ids.add(n['id'])
            if not isinstance(n['pitch'],int) or not 0<=n['pitch']<=127 or not 0<=n['start']<n['end']<=data['duration']+.001 or not 1<=n['velocity']<=127: raise ValueError('INVALID_NOTE')

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--request',required=True); parser.add_argument('--out',required=True)
    args=parser.parse_args(); request=json.loads(Path(args.request).read_text(encoding='utf-8')); out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    mode=request.get('mode','infer'); settings=request.get('settings',{})
    data=infer(request) if mode=='infer' else json.loads(Path(request['dataPath']).read_text(encoding='utf-8'))
    validate_data(data)
    # Cached pages/exports use the already prepared revision, never rerun fingering.
    if mode in ('infer','render'):
        emit(type='progress',phase='量化音符与编排指法',progress=.93)
        data=prepare(data,settings)
    if request.get('trackIds'): data['tracks']=[t for t in data['tracks'] if t['id'] in request['trackIds']]
    if not data['tracks']: raise ValueError('NO_TRACKS_SELECTED')
    if mode=='notation':
        xml,start,total=musicxml(data,settings,request.get('tab',False),request.get('startBar',0),8)
        emit(type='notation',xml=xml,startBeat=start,bars=total); return
    (out/'raw.mid').write_bytes(midi_bytes(data,False)); (out/'quantized.mid').write_bytes(midi_bytes(data,True))
    try:
        for tab,name in [(False,'score.musicxml'),(True,'tab.musicxml')]:
            xml,_,_=musicxml(data,settings,tab); (out/name).write_text(xml,encoding='utf-8')
        for t in data['tracks']:
            bad=sum('string' not in n for n in t['notes']) if 'tuning' in t else 0
            if bad:
                fragments=', '.join(f"{n['start']:.2f}s" for n in t['notes'] if 'string' not in n)[:240]
                data['warnings'].append(f"{t['name']}：{bad} 个音符无法分配可用弦位（{fragments}），完整音符保留在五线谱与卷帘中。")
    except Exception as error: data['warnings'].append('MIDI 已完成，谱面生成失败：'+str(error))
    data['warnings']=list(dict.fromkeys(data['warnings']))
    (out/'score.json').write_text(json.dumps(data,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    emit(type='result',tracks=len(data['tracks']),notes=sum(len(t['notes']) for t in data['tracks']))

if __name__=='__main__':
    try: main()
    except Exception as error:
        emit(type='error',error=str(error)[:1500]); sys.exit(1)
