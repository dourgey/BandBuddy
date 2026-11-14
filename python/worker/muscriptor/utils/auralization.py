"""FluidSynth-based MIDI auralization.

Synthesizes a MIDI file with FluidSynth and blends the result with the
original audio into a stereo mix (L = original, R = synthesis).

Requires:
  - fluidsynth on the system PATH
  - soundfile Python package (already a muscriptor dependency)
"""

import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from mido import MidiFile

from muscriptor.soundfonts import SF2_URL
from muscriptor.utils.audio import load_audio
from muscriptor.utils.beats import read_bar_offset
from muscriptor.utils.download import download_if_necessary

# Pre-downloaded copy at the repo root (kept for checkouts and Docker images
# that already have one); absent that, the soundfont is fetched from SF2_URL
# and cached under ~/.cache/muscriptor/.
_LOCAL_SOUNDFONT = Path(__file__).parent.parent.parent / "MuseScore_General.sf2"
_SAMPLE_RATE = 44100


def _load_mono_44k(path: Path) -> np.ndarray:
    """Return a mono float32 numpy array at 44100 Hz for any audio file."""
    wav = load_audio(str(path), target_sr=_SAMPLE_RATE)  # [1, T]
    return wav[0].numpy()


def _resolve_soundfont(soundfont_path: str | Path | None) -> Path:
    if soundfont_path is None:
        if _LOCAL_SOUNDFONT.exists():
            return _LOCAL_SOUNDFONT
        return download_if_necessary(SF2_URL)
    soundfont_path = Path(soundfont_path)
    if not soundfont_path.exists():
        raise FileNotFoundError(
            f"SoundFont not found: {soundfont_path}\n"
            "Pass --soundfont /path/to/file.sf2, or omit it to use "
            "MuseScore_General.sf2 (downloaded once and cached)."
        )
    return soundfont_path


def _synthesize_midi(midi_path: Path, soundfont_path: Path) -> np.ndarray:
    """Render a MIDI file with FluidSynth → mono float32 array at 44100 Hz.

    Raises:
        RuntimeError: If fluidsynth is not available or fails.
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        synth_tmp = tmp.name
    try:
        # Options must precede the positional soundfont/MIDI arguments:
        # fluidsynth >= 2.5 silently ignores trailing options (exit 0, no
        # output file written).
        result = subprocess.run(
            [
                "fluidsynth",
                "-ni",
                "-F",
                synth_tmp,
                "-r",
                str(_SAMPLE_RATE),
                str(soundfont_path),
                str(midi_path),
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"fluidsynth failed (exit {result.returncode}).\n"
                "Ensure fluidsynth is installed and the SoundFont path is correct.\n"
                f"stderr: {result.stderr.decode(errors='replace')}"
            )
        synth_audio, _ = sf.read(synth_tmp, dtype="float32")
        if synth_audio.ndim > 1:
            synth_audio = synth_audio.mean(axis=1)
        return synth_audio
    finally:
        if os.path.exists(synth_tmp):
            os.remove(synth_tmp)


def synthesize(
    midi_path: str | Path,
    output_path: str | Path,
    soundfont_path: str | Path | None = None,
) -> None:
    """Render just the transcription: MIDI → mono WAV via FluidSynth.

    Args:
        midi_path: Path to the MIDI file to synthesize.
        output_path: Destination WAV file path.
        soundfont_path: Path to a ``.sf2`` SoundFont file.  Defaults to
            MuseScore_General.sf2, downloaded on first use and cached
            locally (see :mod:`muscriptor.soundfonts`).

    Raises:
        RuntimeError: If fluidsynth is not available or fails.
        FileNotFoundError: If the SoundFont file is not found.
    """
    soundfont = _resolve_soundfont(soundfont_path)
    synth_audio = _synthesize_midi(Path(midi_path), soundfont)
    sf.write(str(output_path), synth_audio, _SAMPLE_RATE)


def auralize(
    midi_path: str | Path,
    original_audio_path: str | Path,
    output_path: str | Path,
    soundfont_path: str | Path | None = None,
) -> None:
    """Create a stereo auralization of a transcription.

    Left channel:  original audio
    Right channel: FluidSynth MIDI synthesis (RMS-matched to original)

    Args:
        midi_path: Path to the MIDI file to synthesize.
        original_audio_path: Path to the source audio file (any format soundfile supports).
        output_path: Destination WAV file path.
        soundfont_path: Path to a ``.sf2`` SoundFont file.  Defaults to
            MuseScore_General.sf2, downloaded on first use and cached
            locally (see :mod:`muscriptor.soundfonts`).

    Raises:
        RuntimeError: If fluidsynth is not available or fails.
        FileNotFoundError: If the SoundFont file is not found.
    """
    original_audio_path = Path(original_audio_path)
    output_path = Path(output_path)
    soundfont = _resolve_soundfont(soundfont_path)

    # Synthesize MIDI via FluidSynth
    synth_audio = _synthesize_midi(Path(midi_path), soundfont)

    # Undo any bar-alignment delay, which exists to put bar lines on
    # downbeats and would otherwise offset the synthesis against the original.
    # Negative when empty leading bars were trimmed off the MIDI.
    bar_offset = read_bar_offset(MidiFile(str(midi_path)))
    if bar_offset > 0:
        synth_audio = synth_audio[round(bar_offset * _SAMPLE_RATE) :]
    elif bar_offset < 0:
        synth_audio = np.pad(synth_audio, (round(-bar_offset * _SAMPLE_RATE), 0))

    # Load original audio at 44100 Hz mono
    original_audio = _load_mono_44k(original_audio_path)

    # Pad both to the same length
    length = max(len(original_audio), len(synth_audio))
    original_audio = np.pad(original_audio, (0, length - len(original_audio)))
    synth_audio = np.pad(synth_audio, (0, length - len(synth_audio)))

    # RMS-normalize synthesis to match the original's loudness
    rms_orig = np.sqrt(np.mean(original_audio**2))
    rms_synth = np.sqrt(np.mean(synth_audio**2))
    if rms_synth > 1e-8:
        synth_audio = synth_audio * (rms_orig / rms_synth)

    # Assemble stereo array [T, 2] and write WAV
    stereo = np.stack([original_audio, synth_audio], axis=1)
    sf.write(str(output_path), stereo, _SAMPLE_RATE)
