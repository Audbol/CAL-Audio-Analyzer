// JACK (and PipeWire's JACK layer) loaded at run time.
//
// The module is not linked against libjack: on a computer without JACK or pipewire-jack it must still load and
// offer ALSA. The JACK functions RtAudio calls are defined here and forward to libjack.so.0 once calJackLoad()
// found it; RtAudio's JACK API is only used after that succeeded.

#if defined(__UNIX_JACK__)

#include <dlfcn.h>
#include <jack/jack.h>

#include <cstdarg>
#include <initializer_list>

namespace {
void* gLib = nullptr;

template <typename F>
F sym(const char* name) {
  return gLib ? reinterpret_cast<F>(dlsym(gLib, name)) : nullptr;
}
}  // namespace

// True when libjack (JACK itself, or PipeWire's pipewire-jack) is installed and usable.
bool calJackLoad() {
  if (gLib) return true;
  for (const char* name : {"libjack.so.0", "libjack.so"}) {
    gLib = dlopen(name, RTLD_NOW | RTLD_LOCAL);
    if (gLib) break;
  }
  if (!gLib) return false;
  // Every function RtAudio needs must be there (a broken or very old library is treated as missing)
  const char* needed[] = {"jack_client_open", "jack_client_close", "jack_activate", "jack_deactivate", "jack_connect", "jack_get_buffer_size", "jack_get_sample_rate", "jack_get_ports", "jack_port_by_name", "jack_port_get_buffer", "jack_port_get_latency_range", "jack_port_name", "jack_port_register", "jack_port_unregister", "jack_set_process_callback", "jack_set_xrun_callback", "jack_on_shutdown", "jack_set_error_function", "jack_free"};
  for (const char* n : needed) {
    if (!dlsym(gLib, n)) {
      dlclose(gLib);
      gLib = nullptr;
      return false;
    }
  }
  return true;
}

extern "C" {

jack_client_t* jack_client_open(const char* client_name, jack_options_t options, jack_status_t* status, ...) {
  auto f = sym<jack_client_t* (*)(const char*, jack_options_t, jack_status_t*, ...)>("jack_client_open");
  if (!f) {
    if (status) *status = JackFailure;
    return nullptr;
  }
  // RtAudio passes a server name only with JackServerName
  if (options & JackServerName) {
    va_list ap;
    va_start(ap, status);
    const char* server = va_arg(ap, const char*);
    va_end(ap);
    return f(client_name, options, status, server);
  }
  return f(client_name, options, status);
}

// Each function is looked up once (some run in the audio callback)
#define CAL_JACK_FWD(ret, name, params, args, fail)       \
  ret name params {                                       \
    static ret(*fwd_) params = nullptr;                   \
    if (!fwd_) fwd_ = sym<ret(*) params>(#name);          \
    return fwd_ ? fwd_ args : fail;                             \
  }
#define CAL_JACK_FWD_VOID(name, params, args)             \
  void name params {                                      \
    static void(*fwd_) params = nullptr;                  \
    if (!fwd_) fwd_ = sym<void(*) params>(#name);         \
    if (fwd_) fwd_ args;                                        \
  }

CAL_JACK_FWD(int, jack_client_close, (jack_client_t * c), (c), -1)
CAL_JACK_FWD(int, jack_activate, (jack_client_t * c), (c), -1)
CAL_JACK_FWD(int, jack_deactivate, (jack_client_t * c), (c), -1)
CAL_JACK_FWD(int, jack_connect, (jack_client_t * c, const char* a, const char* b), (c, a, b), -1)
CAL_JACK_FWD(jack_nframes_t, jack_get_buffer_size, (jack_client_t * c), (c), 0)
CAL_JACK_FWD(jack_nframes_t, jack_get_sample_rate, (jack_client_t * c), (c), 0)
CAL_JACK_FWD(const char**, jack_get_ports, (jack_client_t * c, const char* p, const char* t, unsigned long fl), (c, p, t, fl), nullptr)
CAL_JACK_FWD(jack_port_t*, jack_port_by_name, (jack_client_t * c, const char* n), (c, n), nullptr)
CAL_JACK_FWD(void*, jack_port_get_buffer, (jack_port_t * p, jack_nframes_t n), (p, n), nullptr)
CAL_JACK_FWD(const char*, jack_port_name, (const jack_port_t* p), (p), "")
CAL_JACK_FWD(jack_port_t*, jack_port_register, (jack_client_t * c, const char* n, const char* t, unsigned long fl, unsigned long b), (c, n, t, fl, b), nullptr)
CAL_JACK_FWD(int, jack_port_unregister, (jack_client_t * c, jack_port_t* p), (c, p), -1)
CAL_JACK_FWD(int, jack_set_process_callback, (jack_client_t * c, JackProcessCallback cb, void* arg), (c, cb, arg), -1)
CAL_JACK_FWD(int, jack_set_xrun_callback, (jack_client_t * c, JackXRunCallback cb, void* arg), (c, cb, arg), -1)
CAL_JACK_FWD(int, jack_set_client_registration_callback, (jack_client_t * c, JackClientRegistrationCallback cb, void* arg), (c, cb, arg), -1)
CAL_JACK_FWD_VOID(jack_on_shutdown, (jack_client_t * c, JackShutdownCallback cb, void* arg), (c, cb, arg))
CAL_JACK_FWD_VOID(jack_set_error_function, (void (*fn)(const char*)), (fn))
CAL_JACK_FWD_VOID(jack_port_get_latency_range, (jack_port_t * p, jack_latency_callback_mode_t m, jack_latency_range_t* r), (p, m, r))
CAL_JACK_FWD_VOID(jack_free, (void* p), (p))

}  // extern "C"

#else

bool calJackLoad() { return false; }

#endif
