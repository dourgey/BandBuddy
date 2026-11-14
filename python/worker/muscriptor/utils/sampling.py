"""Sampling utilities for autoregressive generation."""

import torch


def length_to_mask(lengths: torch.Tensor, max_len: int | None = None) -> torch.Tensor:
    """Convert a tensor of sequence lengths to a boolean mask."""
    assert len(lengths.shape) == 1
    final_length = int(lengths.max().item()) if not max_len else max_len
    final_length = max(final_length, 1)
    return torch.arange(final_length, device=lengths.device)[None, :] < lengths[:, None]


def multinomial(
    input: torch.Tensor, num_samples: int, replacement: bool = False, *, generator=None
) -> torch.Tensor:
    """torch.multinomial with arbitrary number of dimensions."""
    input_ = input.reshape(-1, input.shape[-1])
    output_ = torch.multinomial(
        input_, num_samples=num_samples, replacement=replacement, generator=generator
    )
    output = output_.reshape(*list(input.shape[:-1]), -1)
    return output


def sample_top_k(probs: torch.Tensor, k: int, num_samples: int = 1) -> torch.Tensor:
    """Sample from top-k probabilities."""
    top_k_value, _ = torch.topk(probs, k, dim=-1)
    min_value_top_k = top_k_value[..., [-1]]
    probs = probs * (probs >= min_value_top_k).float()
    probs = probs / probs.sum(dim=-1, keepdim=True)
    return multinomial(probs, num_samples=num_samples)


def sample_top_p(probs: torch.Tensor, p: float, num_samples: int = 1) -> torch.Tensor:
    """Sample from nucleus (top-p) distribution."""
    probs_sort, probs_idx = torch.sort(probs, dim=-1, descending=True)
    probs_sum = torch.cumsum(probs_sort, dim=-1)
    mask = probs_sum - probs_sort > p
    probs_sort = probs_sort * (~mask).float()
    probs_sort = probs_sort / probs_sort.sum(dim=-1, keepdim=True)
    next_token = multinomial(probs_sort, num_samples=num_samples)
    return torch.gather(probs_idx, -1, next_token)


def sample_from_probs(
    probs: torch.Tensor, top_p: float = 0.0, top_k: int = 0
) -> torch.Tensor:
    """Sample one token from probs, optionally filtered by top-p or top-k."""
    if top_p > 0.0:
        return sample_top_p(probs, top_p)
    if top_k > 0:
        return sample_top_k(probs, top_k)
    return multinomial(probs, num_samples=1)


def sample_stratified(
    probs: torch.Tensor,
    special_token: int,
    first_temp: float,
    second_temp: float = 1.0,
    top_p: float = 0.0,
    top_k: int = 0,
) -> torch.Tensor:
    """Stratified sampling: first decide special vs. non-special, then sample among non-special."""
    eps = 1e-12
    probs_special = probs[..., special_token : special_token + 1].clamp(
        min=eps, max=1 - eps
    )
    logits_two = torch.cat(
        [torch.log(probs_special), torch.log(1 - probs_special)], dim=-1
    )
    logits_two = logits_two / max(first_temp, eps)
    probs_two = torch.softmax(logits_two, dim=-1)
    probs_special_temp = probs_two[..., 0:1]
    next_token_is_special = torch.rand_like(probs_special_temp).lt(probs_special_temp)

    denom = (1 - probs_special).clamp(min=eps)
    new_probs = probs.clone() / denom
    new_probs[..., special_token] = 0.0
    if second_temp > 0:
        log_new = torch.log(new_probs.clamp(min=eps)) / second_temp
        new_probs = torch.softmax(log_new, dim=-1)

    next_token = sample_from_probs(new_probs, top_p=top_p, top_k=top_k)

    return torch.where(
        next_token_is_special, torch.full_like(next_token, special_token), next_token
    )
