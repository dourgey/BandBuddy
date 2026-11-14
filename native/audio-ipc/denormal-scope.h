#pragma once
#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
#include <xmmintrin.h>
#define BB_AUDIO_SSE2 1
#endif

namespace bb {
// Filter/reverb tails can reach subnormal numbers. On x86 their arithmetic
// can cost far more than normal DSP and miss a small ASIO callback deadline.
// Restore the caller's floating-point mode: ASIO owns the callback thread.
class DenormalScope {
 public:
  DenormalScope() noexcept {
#ifdef BB_AUDIO_SSE2
    previous_ = _mm_getcsr();
    _mm_setcsr(previous_ | 0x8040u); // flush-to-zero and denormals-are-zero
#endif
  }
  ~DenormalScope() noexcept {
#ifdef BB_AUDIO_SSE2
    _mm_setcsr(previous_);
#endif
  }
  DenormalScope(const DenormalScope&) = delete;
  DenormalScope& operator=(const DenormalScope&) = delete;
 private:
#ifdef BB_AUDIO_SSE2
  unsigned previous_ = 0;
#endif
};
}
