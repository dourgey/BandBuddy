#include "node.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"
#include <windows.h>
#include <cstring>
#include <iostream>

using namespace Steinberg;
using namespace bb::plugins;
class View final : public U::Implements<U::Directly<IPlugView>> {
 public:
  tresult PLUGIN_API isPlatformTypeSupported(FIDString type) override { return std::strcmp(type, kPlatformTypeHWND) == 0 ? kResultTrue : kResultFalse; }
  tresult PLUGIN_API attached(void*, FIDString) override { return kResultOk; }
  tresult PLUGIN_API removed() override { return kResultOk; }
  tresult PLUGIN_API onWheel(float) override { return kResultFalse; }
  tresult PLUGIN_API onKeyDown(char16, int16, int16) override { return kResultFalse; }
  tresult PLUGIN_API onKeyUp(char16, int16, int16) override { return kResultFalse; }
  tresult PLUGIN_API getSize(ViewRect* rect) override { *rect = {0, 0, 720, 420}; return kResultOk; }
  tresult PLUGIN_API onSize(ViewRect*) override { return kResultOk; }
  tresult PLUGIN_API onFocus(TBool) override { return kResultOk; }
  tresult PLUGIN_API setFrame(IPlugFrame*) override { return kResultOk; }
  tresult PLUGIN_API canResize() override { return kResultFalse; }
  tresult PLUGIN_API checkSizeConstraint(ViewRect*) override { return kResultOk; }
};
int main() {
  initializePlatform();
  View view;
  const auto window = static_cast<HWND>(openEditorWindow(static_cast<IPlugView*>(&view), "BandBuddy editor test"));
  if (!window) return 2;
  pumpPlatform();
  const bool firstOpenVisible = IsWindowVisible(window);
  RECT client{}; GetClientRect(window, &client);
  SendMessageW(window, WM_CLOSE, 0, 0);
  const bool closeHides = !IsWindowVisible(window) && IsWindow(window);
  showEditorWindow(window); pumpPlatform();
  const bool reopenVisible = IsWindowVisible(window);
  closeEditorWindow(window);
  const bool destroyed = !IsWindow(window);
  const bool passed = firstOpenVisible && closeHides && reopenVisible && destroyed && client.right == 720 && client.bottom == 420;
  std::cout << json({{"passed", passed}, {"firstOpenVisible", firstOpenVisible}, {"closeHides", closeHides},
    {"reopenVisible", reopenVisible}, {"destroyed", destroyed}, {"width", client.right}, {"height", client.bottom}}).dump() << std::endl;
  return passed ? 0 : 1;
}
