"""Stateful module API.

Each :class:`StatefulModule` exposes :meth:`init_state` returning a dict of
per-module tensors. :func:`init_states` walks an ``nn.Module`` tree, calls
``init_state`` on every stateful submodule, and returns a ``dict[name -> state]``
that callers thread through ``forward`` via a ``model_state`` argument.

State is mutated only by :meth:`increment_step` (called explicitly via
:func:`increment_steps`) and by ``forward`` writing into preallocated buffers
at known offsets.  No magic context manager, no implicit per-module storage.
"""

from abc import ABC, abstractmethod
from typing import Any
from torch import nn


State = dict[str, Any]
ModelState = dict[str, State]


class StatefulModule(ABC, nn.Module):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._module_absolute_name: str | None = None

    @abstractmethod
    def init_state(self, batch_size: int, sequence_length: int) -> State:
        raise NotImplementedError

    def increment_step(self, state: State, increment: int = 1) -> None:
        pass

    def get_state(self, model_state: ModelState | None) -> State | None:
        if model_state is None or self._module_absolute_name is None:
            return None
        return model_state.get(self._module_absolute_name)


def init_states(model: nn.Module, batch_size: int, sequence_length: int) -> ModelState:
    """Allocate state for every :class:`StatefulModule` reachable from ``model``.

    Side effect: each stateful submodule has its ``_module_absolute_name`` set
    so subsequent ``get_state`` calls can find its slot.
    """
    result: ModelState = {}
    for module_name, module in model.named_modules():
        if isinstance(module, StatefulModule):
            module._module_absolute_name = module_name
            result[module_name] = module.init_state(batch_size, sequence_length)
    return result


def increment_steps(
    model: nn.Module, model_state: ModelState, increment: int = 1
) -> None:
    """Bump the step counter for every stateful submodule of ``model``.

    Uses each module's ``_module_absolute_name`` (set by :func:`init_states`)
    to look up its slot, so this works on subtrees even when ``init_states``
    was called on a different root.
    """
    for _, module in model.named_modules():
        if (
            isinstance(module, StatefulModule)
            and module._module_absolute_name is not None
        ):
            module.increment_step(model_state[module._module_absolute_name], increment)
