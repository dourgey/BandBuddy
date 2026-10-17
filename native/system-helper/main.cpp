#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wintrust.h>
#include <softpub.h>
#include <wincrypt.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#include <initguid.h>
#include <devguid.h>
#include <devpkey.h>
#include <iostream>
#include <string>
#include <vector>

static std::string utf8(const std::wstring& value) {
  const int size=WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),nullptr,0,nullptr,nullptr);
  std::string result(size,'\0'); WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),result.data(),size,nullptr,nullptr); return result;
}
static std::string quoted(const std::wstring& value) {
  std::string out="\""; for(unsigned char c:utf8(value)) { if(c=='\\'||c=='"') out+='\\'; if(c>=32) out+=c; } return out+'"';
}
struct Signature { bool valid=false; std::wstring subject; std::vector<BYTE> certificate; };
static std::wstring deviceString(HDEVINFO set, SP_DEVINFO_DATA& device, const DEVPROPKEY& key) {
  wchar_t value[1024]{}; DEVPROPTYPE type=0; DWORD required=0;
  if(!SetupDiGetDevicePropertyW(set,&device,&key,&type,reinterpret_cast<PBYTE>(value),sizeof(value),&required,0) || type!=DEVPROP_TYPE_STRING) return L"";
  return value;
}
static void inventoryDevices(const GUID& guid, const char* kind, bool& first) {
  auto set=SetupDiGetClassDevsW(&guid,nullptr,nullptr,DIGCF_PRESENT);
  if(set==INVALID_HANDLE_VALUE) { if(!first)std::cout<<","; first=false; std::cout<<"{\"kind\":\""<<kind<<"\",\"probeError\":"<<GetLastError()<<"}"; return; }
  SP_DEVINFO_DATA device{}; device.cbSize=sizeof(device);
  for(DWORD index=0;SetupDiEnumDeviceInfo(set,index,&device);++index) {
    ULONG status=0,problem=0; auto result=CM_Get_DevNode_Status(&status,&problem,device.DevInst,0);
    if(!first)std::cout<<","; first=false;
    std::cout<<"{\"kind\":\""<<kind<<"\",\"name\":"<<quoted(deviceString(set,device,DEVPKEY_Device_DeviceDesc))
      <<",\"manufacturer\":"<<quoted(deviceString(set,device,DEVPKEY_Device_Manufacturer))
      <<",\"driverVersion\":"<<quoted(deviceString(set,device,DEVPKEY_Device_DriverVersion))
      <<",\"driverProvider\":"<<quoted(deviceString(set,device,DEVPKEY_Device_DriverProvider))
      <<",\"status\":"<<status<<",\"problemCode\":"<<((status&DN_HAS_PROBLEM)?problem:0)<<",\"probeError\":"<<result<<"}";
  }
  const auto error=GetLastError();
  if(error!=ERROR_NO_MORE_ITEMS) { if(!first)std::cout<<",";first=false;std::cout<<"{\"kind\":\""<<kind<<"\",\"probeError\":"<<error<<"}"; }
  SetupDiDestroyDeviceInfoList(set);
}
static Signature signature(const wchar_t* file) {
  Signature result;
  WINTRUST_FILE_INFO info{}; info.cbStruct=sizeof(info); info.pcwszFilePath=file;
  WINTRUST_DATA data{}; data.cbStruct=sizeof(data); data.dwUIChoice=WTD_UI_NONE; data.fdwRevocationChecks=WTD_REVOKE_NONE;
  data.dwUnionChoice=WTD_CHOICE_FILE; data.pFile=&info; data.dwStateAction=WTD_STATEACTION_VERIFY;
  // Use the OS trust store and cached revocation data; never disable chain validation.
  data.dwProvFlags=WTD_CACHE_ONLY_URL_RETRIEVAL;
  GUID action=WINTRUST_ACTION_GENERIC_VERIFY_V2;
  result.valid=WinVerifyTrust(nullptr,&action,&data)==ERROR_SUCCESS;
  if(result.valid) {
    auto provider=WTHelperProvDataFromStateData(data.hWVTStateData);
    auto signer=provider?WTHelperGetProvSignerFromChain(provider,0,FALSE,0):nullptr;
    if(signer&&signer->csCertChain) {
      auto cert=signer->pasCertChain[0].pCert;
      DWORD length=CertNameToStrW(X509_ASN_ENCODING,&cert->pCertInfo->Subject,CERT_X500_NAME_STR,nullptr,0);
      std::wstring name(length,L'\0'); CertNameToStrW(X509_ASN_ENCODING,&cert->pCertInfo->Subject,CERT_X500_NAME_STR,name.data(),length);
      if(!name.empty()&&name.back()==L'\0') name.pop_back(); result.subject=name;
      result.certificate.assign(cert->pbCertEncoded,cert->pbCertEncoded+cert->cbCertEncoded);
    } else result.valid=false;
  }
  data.dwStateAction=WTD_STATEACTION_CLOSE; WinVerifyTrust(nullptr,&action,&data); return result;
}
int wmain(int argc,wchar_t** argv) {
  if(argc<2) return 2;
  std::wstring command=argv[1];
  if(command==L"self-test") { std::cout<<"{\"ok\":true}"; return 0; }
  if(command==L"inventory") {
    SYSTEM_INFO system{};GetNativeSystemInfo(&system);MEMORYSTATUSEX memory{};memory.dwLength=sizeof(memory);
    const bool memoryOk=GlobalMemoryStatusEx(&memory)!=FALSE;
    std::cout<<"{\"schema\":1,\"architecture\":"<<system.wProcessorArchitecture<<",\"processors\":"<<system.dwNumberOfProcessors
      <<",\"memoryKnown\":"<<(memoryOk?"true":"false")<<",\"totalMemory\":"<<memory.ullTotalPhys<<",\"availableMemory\":"<<memory.ullAvailPhys
      <<",\"devices\":[";
    bool first=true;inventoryDevices(GUID_DEVCLASS_DISPLAY,"display",first);inventoryDevices(GUID_DEVCLASS_MEDIA,"audio",first);
    std::cout<<"]}";return 0;
  }
  if(command==L"vc-runtime") {
    DWORD installed=0,size=sizeof(installed); wchar_t version[128]{}; DWORD bytes=sizeof(version);
    auto key=L"SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64";
    const auto installedError=RegGetValueW(HKEY_LOCAL_MACHINE,key,L"Installed",RRF_RT_REG_DWORD|RRF_SUBKEY_WOW6464KEY,nullptr,&installed,&size);
    const auto versionError=RegGetValueW(HKEY_LOCAL_MACHINE,key,L"Version",RRF_RT_REG_SZ|RRF_SUBKEY_WOW6464KEY,nullptr,version,&bytes);
    const auto error=(installedError!=ERROR_SUCCESS&&installedError!=ERROR_FILE_NOT_FOUND)?installedError:(installed&&versionError!=ERROR_SUCCESS)?versionError:ERROR_SUCCESS;
    std::cout<<"{\"installed\":"<<(installed?"true":"false")<<",\"version\":"<<quoted(version)<<",\"probeError\":"<<error<<"}"; return 0;
  }
  if(command==L"signature"&&argc==3) {
    const auto info=signature(argv[2]); std::cout<<"{\"status\":\""<<(info.valid?"Valid":"Invalid")<<"\",\"subject\":"<<quoted(info.subject)<<"}"; return 0;
  }
  if(command==L"same-publisher"&&argc==4) {
    const auto a=signature(argv[2]),b=signature(argv[3]);
    if(a.valid&&b.valid&&!a.certificate.empty()&&a.certificate==b.certificate) { std::cout<<"trusted"; return 0; } return 1;
  }
  if(command==L"install-vc"&&argc==4) {
    const auto trusted=signature(argv[2]);
    if(!trusted.valid||trusted.subject.find(L"O=Microsoft Corporation")==std::wstring::npos) return 5;
    std::wstring mode=argv[3]; if(mode!=L"/install"&&mode!=L"/repair") return 2;
    const std::wstring parameters=mode+L" /quiet /norestart";
    SHELLEXECUTEINFOW execute{}; execute.cbSize=sizeof(execute); execute.fMask=SEE_MASK_NOCLOSEPROCESS|SEE_MASK_NOASYNC;
    execute.lpVerb=L"runas"; execute.lpFile=argv[2]; execute.lpParameters=parameters.c_str(); execute.nShow=SW_HIDE;
    if(!ShellExecuteExW(&execute)) return static_cast<int>(GetLastError());
    // Let Microsoft's installer finish atomically even if the parent app exits.
    WaitForSingleObject(execute.hProcess,INFINITE); DWORD code=1; GetExitCodeProcess(execute.hProcess,&code); CloseHandle(execute.hProcess); return static_cast<int>(code);
  }
  return 2;
}
