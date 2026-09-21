#include "effects.h"
#include <string>
static std::string error;
extern "C" {
const char* bb_error() {return error.c_str();}
bb::Effects* bb_create(const char* json,unsigned rate) {try {return new bb::Effects(nlohmann::json::parse(json),rate);}catch(const std::exception& e){error=e.what();return nullptr;}}
void bb_destroy(bb::Effects* p) {delete p;}
int bb_update(bb::Effects* p,const char* json) {try{p->update(nlohmann::json::parse(json));return 1;}catch(const std::exception& e){error=e.what();return 0;}}
void bb_process(bb::Effects* p,const float* in,float* out,unsigned frames,unsigned channels) {p->process(in,out,frames,channels);}
}
