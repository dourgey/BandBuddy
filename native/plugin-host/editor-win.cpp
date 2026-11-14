#include "node.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include <windows.h>
#include <objbase.h>
#include <algorithm>
namespace bb::plugins {
using namespace Steinberg;
static void applyScale(IPlugView* view, UINT dpi) {
  IPlugViewContentScaleSupport* scale = nullptr;
  if (view->queryInterface(IPlugViewContentScaleSupport::iid, reinterpret_cast<void**>(&scale)) == kResultOk && scale) {
    scale->setContentScaleFactor(static_cast<float>(dpi) / 96.f);
    scale->release();
  }
}
static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_CLOSE) { ShowWindow(window, SW_HIDE); return 0; }
  if (message == WM_DPICHANGED) {
    auto* view = reinterpret_cast<IPlugView*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    const auto* suggested = reinterpret_cast<RECT*>(l);
    SetWindowPos(window, nullptr, suggested->left, suggested->top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    if (view) {
      applyScale(view, HIWORD(w));
      ViewRect rect{};
      if (view->getSize(&rect) == kResultOk) { resizeEditorWindow(window, rect.getWidth(), rect.getHeight()); view->onSize(&rect); }
    }
    return 0;
  }
  return DefWindowProcW(window, message, w, l);
}
void initializePlatform() {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW type{}; type.lpfnWndProc = procedure; type.hInstance = GetModuleHandleW(nullptr);
  type.lpszClassName = L"BandBuddyPluginEditor"; type.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassW(&type);
}
void pumpPlatform() {
  MSG message{}; while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
}
void resizeEditorWindow(void* pointer, int width, int height) {
  const auto window = static_cast<HWND>(pointer);
  if (!window || width < 1 || height < 1 || width > 8192 || height > 8192) return;
  RECT r{0, 0, width, height};
  AdjustWindowRectExForDpi(&r, static_cast<DWORD>(GetWindowLongPtrW(window, GWL_STYLE)), FALSE,
    static_cast<DWORD>(GetWindowLongPtrW(window, GWL_EXSTYLE)), GetDpiForWindow(window));
  const int outerWidth = r.right - r.left, outerHeight = r.bottom - r.top;
  RECT current{}; GetWindowRect(window, &current);
  MONITORINFO monitor{sizeof(MONITORINFO)};
  GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor);
  const auto& work = monitor.rcWork;
  const int x = std::clamp(current.left, work.left, std::max(work.left, work.right - outerWidth));
  const int y = std::clamp(current.top, work.top, std::max(work.top, work.bottom - outerHeight));
  SetWindowPos(window, nullptr, x, y, outerWidth, outerHeight, SWP_NOZORDER | SWP_NOACTIVATE);
}
void* openEditorWindow(void* pointer, const std::string& title, void** publishedWindow) {
  auto* view = static_cast<IPlugView*>(pointer);
  if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) return nullptr;
  const auto count = MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, nullptr, 0);
  std::wstring text(count, 0); MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, text.data(), count);
  auto window = CreateWindowW(L"BandBuddyPluginEditor", text.c_str(), WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
    CW_USEDEFAULT, CW_USEDEFAULT, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!window) return nullptr;
  // Plugins can call resizeView from setContentScaleFactor/attached. Publish
  // the HWND before either callback, instead of rejecting their first resize.
  if (publishedWindow) *publishedWindow = window;
  SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(view));
  applyScale(view, GetDpiForWindow(window));
  ViewRect rect{};
  if (view->getSize(&rect) == kResultTrue) resizeEditorWindow(window, rect.getWidth(), rect.getHeight());
  if (view->attached(window, kPlatformTypeHWND) != kResultTrue) { if (publishedWindow) *publishedWindow = nullptr; DestroyWindow(window); return nullptr; }
  if (view->getSize(&rect) == kResultTrue) { resizeEditorWindow(window, rect.getWidth(), rect.getHeight()); view->onSize(&rect); }
  // spawnSafe starts workers with windowsHide:true. Windows applies that
  // STARTUPINFO visibility to the first ShowWindow call, ignoring SW_SHOW.
  // Explicitly restore after consuming it so the editor is visible on its
  // first request, and give it the same foreground handling as a reopen.
  ShowWindow(window, SW_SHOW); showEditorWindow(window); return window;
}
void showEditorWindow(void* window) { ShowWindow(static_cast<HWND>(window), SW_RESTORE); SetForegroundWindow(static_cast<HWND>(window)); }
void closeEditorWindow(void* window) { DestroyWindow(static_cast<HWND>(window)); }
}
