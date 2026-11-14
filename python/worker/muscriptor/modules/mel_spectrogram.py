"""Standalone pure-torch equivalent of torchaudio.transforms.MelSpectrogram.

Matches torchaudio with mel_scale='htk', norm=None, win_length == n_fft.
"""

import torch
from torch import nn


def _hz_to_mel_htk(freq: torch.Tensor) -> torch.Tensor:
    return 2595.0 * torch.log10(1.0 + freq / 700.0)


def _mel_to_hz_htk(mel: torch.Tensor) -> torch.Tensor:
    return 700.0 * (10 ** (mel / 2595.0) - 1.0)


def melscale_fbanks(
    n_freqs: int,
    f_min: float,
    f_max: float,
    n_mels: int,
    sample_rate: int,
) -> torch.Tensor:
    """Triangular mel filterbank matching torchaudio.functional.melscale_fbanks
    with mel_scale='htk' and norm=None. Returns a tensor of shape [n_freqs, n_mels]."""
    all_freqs = torch.linspace(0, sample_rate // 2, n_freqs)
    m_min = _hz_to_mel_htk(torch.tensor(float(f_min)))
    m_max = _hz_to_mel_htk(torch.tensor(float(f_max)))
    m_pts = torch.linspace(m_min.item(), m_max.item(), n_mels + 2)
    f_pts = _mel_to_hz_htk(m_pts)

    f_diff = f_pts[1:] - f_pts[:-1]
    slopes = f_pts.unsqueeze(0) - all_freqs.unsqueeze(1)
    down_slopes = -slopes[:, :-2] / f_diff[:-1]
    up_slopes = slopes[:, 2:] / f_diff[1:]
    return torch.maximum(torch.zeros(()), torch.minimum(down_slopes, up_slopes))


class _Spectrogram(nn.Module):
    """Holds the STFT window so the safetensors key
    `...mel_spec_transform.spectrogram.window` round-trips."""

    def __init__(self, n_fft: int):
        super().__init__()
        self.register_buffer("window", torch.hann_window(n_fft))


class _MelScale(nn.Module):
    """Holds the mel filterbank so the safetensors key
    `...mel_spec_transform.mel_scale.fb` round-trips."""

    def __init__(self, fb: torch.Tensor):
        super().__init__()
        self.register_buffer("fb", fb)


class _MelSpectrogram(nn.Module):
    """Pure-torch equivalent of torchaudio.transforms.MelSpectrogram
    (htk mel scale, no Slaney norm, win_length == n_fft)."""

    def __init__(
        self,
        sample_rate: int,
        n_fft: int,
        hop_length: int,
        n_mels: int,
        power: float = 2.0,
        center: bool = True,
        pad_mode: str = "reflect",
    ):
        super().__init__()
        self.n_fft = n_fft
        self.hop_length = hop_length
        self.power = power
        self.center = center
        self.pad_mode = pad_mode

        self.spectrogram = _Spectrogram(n_fft)
        fb = melscale_fbanks(
            n_freqs=n_fft // 2 + 1,
            f_min=0.0,
            f_max=sample_rate / 2.0,
            n_mels=n_mels,
            sample_rate=sample_rate,
        )
        self.mel_scale = _MelScale(fb)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        leading = x.shape[:-1]
        x = x.reshape(-1, x.shape[-1])
        spec = torch.stft(
            x,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.n_fft,
            window=self.spectrogram.window,
            center=self.center,
            pad_mode=self.pad_mode,
            return_complex=True,
            normalized=False,
            onesided=True,
        )
        spec = spec.abs() ** self.power
        mel = torch.matmul(spec.transpose(-1, -2), self.mel_scale.fb).transpose(-1, -2)
        return mel.reshape(*leading, *mel.shape[-2:])
