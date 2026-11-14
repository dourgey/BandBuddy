"""Inference-only grouping of equal-sized bands using ordinary PyTorch bmm.

Same weights, nonlinearities, and band order. No optional kernels or packages.
Kept experimental until end-to-end numerical and speed checks have passed.
"""
from collections import defaultdict
import torch
from torch import nn
import torch.nn.functional as F


class GroupedBandSplit(nn.Module):
    def __init__(self, original):
        super().__init__()
        self.dim_inputs = original.dim_inputs
        grouped = defaultdict(list)
        for i, size in enumerate(self.dim_inputs):
            grouped[size].append(i)
        self.groups = list(grouped.items())
        for group_id, (size, indices) in enumerate(self.groups):
            nets = [original.to_features[i] for i in indices]
            for suffix, value in (
                ("gamma", torch.stack([net[0].gamma.detach() for net in nets])),
                ("weight", torch.stack([net[1].weight.detach() for net in nets])),
                ("bias", torch.stack([net[1].bias.detach() for net in nets])),
            ):
                self.register_buffer(f"{suffix}_{group_id}", value)

    def forward(self, x):
        splits = x.split(self.dim_inputs, dim=-1)
        out = [None]*len(splits)
        b, t = x.shape[:2]
        for group_id, (size, indices) in enumerate(self.groups):
            value = torch.stack([splits[i] for i in indices], dim=0)
            value = F.normalize(value, dim=-1) * (size**.5) * getattr(self, f"gamma_{group_id}")[:, None, None]
            value = torch.bmm(value.reshape(len(indices), b*t, size), getattr(self, f"weight_{group_id}").transpose(-1,-2))
            value = value + getattr(self, f"bias_{group_id}")[:, None].to(value.dtype)
            value = value.reshape(len(indices), b, t, -1)
            for j, i in enumerate(indices):
                out[i] = value[j]
        return torch.stack(out, dim=-2)


class GroupedMaskEstimator(nn.Module):
    def __init__(self, original):
        super().__init__()
        grouped = defaultdict(list)
        for i, size in enumerate(original.dim_inputs):
            grouped[size].append(i)
        self.groups = list(grouped.items())
        self.num_bands = len(original.dim_inputs)
        for group_id, (_, indices) in enumerate(self.groups):
            nets = [original.to_freqs[i][0] for i in indices]
            assert all(len(net) == 3 and isinstance(net[1], nn.Tanh) for net in nets)
            for suffix, value in (
                ("w1", torch.stack([net[0].weight.detach() for net in nets])),
                ("b1", torch.stack([net[0].bias.detach() for net in nets])),
                ("w2", torch.stack([net[2].weight.detach() for net in nets])),
                ("b2", torch.stack([net[2].bias.detach() for net in nets])),
            ):
                self.register_buffer(f"{suffix}_{group_id}", value)

    def forward(self, x):
        out = [None]*self.num_bands
        b, t, _, d = x.shape
        for group_id, (_, indices) in enumerate(self.groups):
            value = x[:, :, indices].permute(2, 0, 1, 3).reshape(len(indices), b*t, d)
            value = torch.bmm(value, getattr(self, f"w1_{group_id}").transpose(-1,-2))
            value = torch.tanh(value + getattr(self, f"b1_{group_id}")[:, None].to(value.dtype))
            value = torch.bmm(value, getattr(self, f"w2_{group_id}").transpose(-1,-2))
            value = F.glu(value + getattr(self, f"b2_{group_id}")[:, None].to(value.dtype), dim=-1)
            value = value.reshape(len(indices), b, t, -1)
            for j, i in enumerate(indices):
                out[i] = value[j]
        return torch.cat(out, dim=-1)


def install(model):
    model.band_split = GroupedBandSplit(model.band_split)
    model.mask_estimators = nn.ModuleList([GroupedMaskEstimator(head) for head in model.mask_estimators])
    model.eval().requires_grad_(False)
    return model
