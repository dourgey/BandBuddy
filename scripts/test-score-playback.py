"""Real AudioWorklet regression against the development ?fixtures bridge.

Requires Python Playwright + Chromium and the verified MuseScore_General.sf3.
Run a renderer dev server, then pass --url and --soundfont; see docs/SCORES.md.
"""
import argparse
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:5178/?fixtures')
parser.add_argument('--soundfont', required=True, type=Path)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
assert hashlib.sha256(args.soundfont.read_bytes()).hexdigest() == '5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3', 'SoundFont checksum mismatch'

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=['--autoplay-policy=no-user-gesture-required'])
    try:
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/score-fixture.sf3', lambda route: route.fulfill(path=str(args.soundfont), content_type='application/octet-stream'))
        page.goto(args.url, wait_until='networkidle')
        result = page.evaluate("""async () => {
            const {ScoreAudio} = await import('/src/scores/audio.ts');
            const audio = new ScoreAudio(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
            try {
                const tracks = Array.from({length: 20}, (_, i) => ({id: 't'+i, sourceId: 's'+i, name: 'Independent guitar '+i, instrument: 'clean_electric_guitar', program: 26, isDrum: false, notes: [{id: 'n'+i, pitch: 60+i%12, start: 0, end: 6, velocity: 100}]}));
                const data = {version: 1, duration: 8, tracks, tempo: {points: [{time: 0, beat: 0}, {time: 8, beat: 16}], bpm: 120, numerator: 4, denominator: 4, firstDownbeat: 0, provisional: false}, warnings: []};
                let practice = {rate: 1, position: 0, loop: null, tracks: Object.fromEntries(tracks.map((t,i) => [t.id,{mute: false, solo: i===19, volume: .7}]))};
                await audio.play(data, practice, '20 tracks', ''); await pause(150);
                const midi = await audio.seq.getMIDI(), channels = audio.channels.slice(), count = audio.synth.midiChannels.length;
                if (count < 32 || new Set(channels).size !== 20 || midi.duration !== 8) throw Error('Channel allocation or trailing silence lost');
                const analyser = audio.context.createAnalyser(); analyser.fftSize = 2048; audio.synth.connect(analyser);
                const rms = () => {const x = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(x); return Math.sqrt(x.reduce((s,v)=>s+v*v,0)/x.length)};
                await audio.seek(3); await pause(100); const held = rms();
                if (held < .00001) throw Error('Sustain missing after seek');
                audio.setMix({...practice, tracks: {...practice.tracks, t19: {solo: true, mute: true, volume: .7}}});
                await pause(400); const muted = rms();
                if (muted > held*.25) throw Error('Solo track mute did not silence output');
                practice = {...practice, rate: 3}; audio.setMix(practice);
                const before = audio.position; await pause(200); const advance = audio.position-before;
                if (advance < .4 || advance > 1) throw Error('Rate clock incorrect '+advance);
                await audio.play(data, {...practice, rate: 1, position: 2, loop: {a: 2,b: 2.5}}, 'AB', '');
                const positions = [];
                for (let i=0;i<30;i++) {await pause(70); positions.push(audio.position)}
                const wraps = positions.filter((p,i)=>i>0&&p<positions[i-1]-.1).length;
                if (positions.some(p=>p<2||p>2.501) || !audio.playing || wraps<3) throw Error('Loop bounds or repetition failed');
                await Promise.all([audio.seek(2.1), audio.seek(2.3), audio.seek(2.2)]); await pause(70);
                audio.pause(); const stopped = audio.position; await pause(120);
                if (audio.playing || audio.position!==stopped) throw Error('Pause clock incorrect');
                const restData = {...data, tracks: [{...tracks[0], notes: [{...tracks[0].notes[0], start: 2.2, end: 2.5}]}]};
                const first = audio.play(data, {...practice, position: 0,loop: null}, 'Superseded request', '');
                const second = audio.play(restData, {rate: 1, position: 2, loop: {a: 2,b: 3},tracks: {}}, 'AB with silence', '');
                await Promise.all([first,second]);
                const restMidi = await audio.seq.getMIDI();
                if (restMidi.duration!==1 || !audio.playing) throw Error('Overlapping load or silent loop boundaries failed');
                const restPositions = [];
                for (let i=0;i<35;i++) {await pause(70); restPositions.push(audio.position)}
                if (Math.min(...restPositions)>2.12 || Math.max(...restPositions)<2.85 || restPositions.some(p=>p<2||p>3.001)) throw Error('Loop trimmed leading/trailing rests');
                return {channels, allocatedChannels: count, duration: midi.duration, heldRms: held, mutedRms: muted, rateAdvance: advance, loopWraps: wraps, pausedPosition: stopped, silenceLoopDuration: restMidi.duration};
            } finally {audio.destroy()}
        }""")
        assert not errors, errors
        result['pageErrors'] = errors
        serialized = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output: args.output.write_text(serialized, encoding='utf-8')
        print(serialized)
    finally:
        browser.close()
