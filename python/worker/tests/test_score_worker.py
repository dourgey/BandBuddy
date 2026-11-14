"""Run with the isolated score runtime: python -m unittest discover -s python/worker/tests -p test_score_worker.py."""
import copy
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch, MagicMock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import score_worker as w
import mido

def note(identifier='a', pitch=64, start=.25, end=.75):
    return dict(id=identifier,pitch=pitch,start=start,end=end,velocity=100)

def track(identifier='guitar-a', notes=None, instrument='clean_electric_guitar', drum=False):
    return dict(id=identifier,sourceId=identifier,name=identifier,instrument=instrument,program=26,isDrum=drum,notes=notes if notes is not None else [note(identifier+'-note')])

def source(tracks=None,duration=8):
    return dict(version=1,duration=duration,tracks=tracks if tracks is not None else [track()],tempo=w.default_tempo(duration),warnings=[])

def xml(data,settings=None,tab=False,start=0,count=None):
    prepared=w.prepare(data,settings or {})
    return ET.fromstring(w.musicxml(prepared,settings or {},tab,start,count)[0])

def midi_note_times(data,quantized=False):
    mid=mido.MidiFile(file=io.BytesIO(w.midi_bytes(data,quantized)))
    seconds=0; events=[]
    for message in mid:
        seconds+=message.time
        if message.type in ('note_on','note_off'): events.append((message,seconds))
    return mid,events

class ScoreWorkerTests(unittest.TestCase):
    def test_raw_midi_keeps_pickup_audio_origin(self):
        data=source(); data['tempo']['firstDownbeat']=1.5
        prepared=w.prepare(data,{})
        self.assertGreater(prepared['tracks'][0]['notes'][0]['beat'],0)
        _,events=midi_note_times(prepared)
        self.assertAlmostEqual(events[0][1],.25,places=3)
        self.assertAlmostEqual(events[1][1],.75,places=3)

    def test_tempo_changes_preserve_original_seconds(self):
        data=source([track(notes=[note('a',64,.25,2.5),note('b',67,3.2,4.2)])])
        data['tempo']['points']=[dict(time=0,beat=0),dict(time=2,beat=4),dict(time=4,beat=6),dict(time=8,beat=14)]
        prepared=w.prepare(data,{})
        _,events=midi_note_times(prepared)
        self.assertEqual([round(t,3) for _,t in events],[.25,2.5,3.2,4.2])
        doc=xml(data)
        self.assertEqual([float(n.attrib['tempo']) for n in doc.findall('.//sound')],[120,60,120])

    def test_same_program_stems_have_distinct_channels_ports(self):
        data=w.prepare(source([track(f'lead-{i}') for i in range(20)]+[track('drums-a',drum=True),track('drums-b',drum=True)]),{})
        mid,_=midi_note_times(data)
        self.assertEqual(mid.type,1); self.assertEqual(len(mid.tracks),23)
        identities=[]
        for t in mid.tracks[1:]:
            port=next(m.port for m in t if m.type=='midi_port')
            channel=next(m.channel for m in t if m.type=='note_on')
            identities.append((port,channel))
        self.assertEqual(len(identities),len(set(identities)))
        self.assertTrue(all(channel!=9 for _,channel in identities[:20]))
        self.assertEqual(identities[-2:],[(0,9),(1,9)])

    def test_requantizing_preserves_raw_ids_times_and_detected_grid(self):
        initial=source([track(notes=[note('x',64,.21,1.04)])])
        first=w.prepare(initial,{'bpm':90,'subdivision':2})
        second=w.prepare(first,{'bpm':140,'firstDownbeat':.4,'subdivision':6})
        self.assertEqual(second['detectedTempo'],initial['tempo'])
        self.assertEqual({k:second['tracks'][0]['notes'][0][k] for k in ('id','pitch','start','end','velocity')},initial['tracks'][0]['notes'][0])

    def test_rerender_discards_old_engraving_errors_but_keeps_inference_warnings(self):
        initial=source([track(notes=[note('x',64,.21,1.04)])])
        initial['warnings']=['节拍检测未完成，使用临时 120 BPM 网格：测试']
        first=w.prepare(initial,{})
        first['warnings'].append('MIDI 已完成，谱面生成失败：旧排版错误')
        second=w.prepare(first,{'bpm':100})
        self.assertEqual(second['warnings'],['节拍检测未完成，已使用手动记谱网格：测试'])
        self.assertEqual(second['inferenceWarnings'],initial['warnings'])

    def test_overlapping_notes_use_voices_and_equal_spans_form_chords(self):
        doc=xml(source([track(notes=[note('a',60,0,1),note('b',64,0,1),note('c',67,.5,1.5)])]))
        self.assertEqual(len(doc.findall('.//note/chord')),1)
        self.assertEqual({n.text for n in doc.findall('.//note/voice')},{'1','2'})
        self.assertTrue(doc.findall('.//backup'))

    def test_cross_bar_and_five_second_sustain_ties(self):
        doc=xml(source([track(notes=[note('sustain',64,3.75,5.75)])]))
        self.assertTrue(doc.findall('.//tie[@type="start"]'))
        self.assertTrue(doc.findall('.//tie[@type="stop"]'))
        parts=doc.findall('.//note[pitch]')
        self.assertEqual(sum(int(n.findtext('duration')) for n in parts),1920)

    def test_triplets_and_compound_meter_measure_duration(self):
        doc=xml(source([track(notes=[note('t',64,0,1/6)])]),{'subdivision':6,'numerator':6,'denominator':8})
        self.assertIsNotNone(doc.find('.//time-modification'))
        for measure in doc.findall('.//measure'):
            self.assertEqual(sum(int(n.findtext('duration')) for n in measure.findall('note')),1440)

    def test_piano_double_staff_and_written_octave(self):
        piano=xml(source([track(notes=[note('l',36,0,1),note('r',72,0,1)],instrument='acoustic_piano')]))
        self.assertEqual(piano.findtext('.//staves'),'2')
        guitar=xml(source(),tab=True)
        self.assertEqual(guitar.findtext('.//transpose/octave-change'),'-1')
        self.assertEqual(guitar.findtext('.//note/pitch/octave'),'5')

    def test_tab_no_string_collisions_or_illegal_frets(self):
        notes=[note(str(i),p,0,2) for i,p in enumerate([40,45,50,55,59,64,90])]
        prepared=w.prepare(source([track(notes=notes)]),{})
        assigned=[n for n in prepared['tracks'][0]['notes'] if 'string' in n]
        self.assertEqual(len({n['string'] for n in assigned}),len(assigned))
        for n in assigned:
            self.assertEqual(w.TUNINGS['guitar'][0][6-n['string']]+n['fret'],n['pitch'])
            self.assertLessEqual(n['fret'],22)
        self.assertEqual(len(prepared['tracks'][0]['notes']),7)
        doc=xml(source([track(notes=notes)]),tab=True)
        self.assertFalse(doc.findall('.//note[chord]/rest'))
        self.assertTrue(doc.findall('.//lyric/text'))

    def test_drop_d_and_five_string_bass(self):
        guitar=w.prepare(source([track(notes=[note('d',38)])]),{'tunings':{'guitar-a':'drop-d'}})
        self.assertEqual(guitar['tracks'][0]['notes'][0]['fret'],0)
        bass=w.prepare(source([track('bass',notes=[note('b',23)],instrument='electric_bass')]),{'tunings':{'bass':'bass-5'}})
        self.assertEqual(bass['tracks'][0]['notes'][0]['string'],5)

    def test_tab_keeps_occupied_strings_during_sustains(self):
        prepared=w.prepare(source([track(notes=[note('held',64,0,2),note('later',64,.5,1)])]),{})
        a,b=prepared['tracks'][0]['notes']; self.assertNotEqual(a['string'],b['string'])

    def test_page_has_absolute_measure_numbers_and_stable_note_ids(self):
        doc=xml(source([track(notes=[note('late',64,17,18)])],duration=32),start=8,count=8)
        self.assertEqual(doc.find('.//measure').attrib['number'],'9')
        self.assertEqual(len(doc.findall('.//measure')),8)
        self.assertTrue(any(n.attrib.get('id','').startswith('nlate-') for n in doc.findall('.//note')))

    def test_drum_export_uses_unpitched_instruments(self):
        doc=xml(source([track(notes=[note('kick',36),note('snare',38)],instrument='drums',drum=True)]))
        self.assertTrue(doc.findall('.//unpitched'))
        self.assertEqual({e.text for e in doc.findall('.//midi-unpitched')},{'37','39'})

    def test_invalid_note_and_tempo_rejected(self):
        for mutation in ('nan','pitch','time','tempo','duplicate'):
            data=source(); n=data['tracks'][0]['notes'][0]
            if mutation=='nan':n['start']=math.nan
            if mutation=='pitch':n['pitch']=128
            if mutation=='time':n['end']=n['start']
            if mutation=='tempo':data['tempo']['points'][1]['time']=0
            if mutation=='duplicate':data['tracks'][0]['notes'].append(dict(n))
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):w.validate_data(data)

    def test_cli_notation_failure_preserves_midi(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); data=w.prepare(source(),{})
            # A damaged notation cache cannot prevent raw MIDI export.
            data['tracks'][0]['notes'][0]['durationBeats']=.123
            (root/'input.json').write_text(json.dumps(data),encoding='utf-8')
            (root/'request.json').write_text(json.dumps(dict(mode='export',dataPath=str(root/'input.json'),settings={})),encoding='utf-8')
            result=subprocess.run([sys.executable,str(Path(w.__file__)),'--request',str(root/'request.json'),'--out',str(root/'out')],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertTrue((root/'out/raw.mid').exists())
            self.assertIn('MIDI 已完成',json.loads((root/'out/score.json').read_text(encoding='utf-8'))['warnings'][0])

    def test_inference_adapter_keeps_streamed_sustain_and_source_identity(self):
        from muscriptor.events import NoteStartEvent,NoteEndEvent,ProgressEvent
        from muscriptor import TranscriptionModel
        start=NoteStartEvent(64,4.8,0,'clean_electric_guitar')
        model=MagicMock(); model._tokenizer.group_program_map={5:[26,27,28]}
        model.transcribe.side_effect=lambda *args,**kw:iter([start,ProgressEvent(1,2),NoteEndEvent(5.7,start),ProgressEvent(2,2)])
        request=dict(model='small',device='cpu',weights='unused',beatAudio='missing',beatCheckpoint='missing',sources=[dict(id=s,name=s,audio='unused',duration=8,stemType='lead_guitar') for s in ('lead','rhythm')])
        with patch.object(TranscriptionModel,'load_model',return_value=model),patch('sys.stdout',new=io.StringIO()):data=w.infer(request)
        self.assertEqual(len(data['tracks']),2)
        self.assertNotEqual(data['tracks'][0]['id'],data['tracks'][1]['id'])
        self.assertEqual(data['tracks'][0]['notes'][0]['end'],5.7)
        self.assertTrue(model.transcribe.call_args.kwargs['prelude_forcing'])
        self.assertEqual(data['tracks'][0]['notes'][0]['velocity'],100)
        self.assertIn('peakResidentBytes',data['metrics'])

    @unittest.skipUnless(os.environ.get('MUSICXML_SCHEMA'),'Set MUSICXML_SCHEMA to the official MusicXML 4 schema for schema validation')
    def test_official_musicxml_schema(self):
        from lxml import etree
        schema=etree.XMLSchema(etree.parse(os.environ['MUSICXML_SCHEMA']))
        data=source([track(notes=[note('g1',64,0,4.5),note('g2',127,0,1)]),track('piano',[note('p1',36),note('p2',72)],'acoustic_piano'),track('drums',[note('d1',36),note('d2',38)],'drums',True)])
        for tab in (False,True):
            doc=xml(data,tab=tab)
            schema.assertValid(etree.fromstring(ET.tostring(doc)))

if __name__=='__main__':unittest.main()
