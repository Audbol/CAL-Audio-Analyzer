// CAL Audio Analyzer native audio I/O (ASIO on Windows) for the desktop app.
//
// The audio callback runs on the driver's thread and never waits for JavaScript:
//  - output: the generator signal (mono) is taken from a lock-free ring filled ahead by JavaScript and written
//    to the selected output channels; when the ring runs dry, silence is played;
//  - input: every input frame is stored together with the generator sample that was actually played in the
//    same callback (silence included), so the internal reference stays sample-aligned with the inputs even
//    if JavaScript falls behind.
// JavaScript is woken after each callback (coalesced) and reads the captured frames with read().
//
// A built-in virtual device ("test" API, enabled with CAL_NATIVE_TEST=1) runs the same path without
// hardware: input 1 is the output delayed by 480 samples, input 2 is a direct loopback.

#include <napi.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "RtAudio.h"

#if defined(__WINDOWS_ASIO__)
#include "asio.h"
#endif

namespace {

// Single-producer / single-consumer ring of floats.
class Ring {
 public:
  void reset(size_t capacity) {
    buf_.assign(capacity, 0.0f);
    cap_ = capacity;
    w_.store(0);
    r_.store(0);
  }
  size_t size() const { return static_cast<size_t>(w_.load(std::memory_order_acquire) - r_.load(std::memory_order_acquire)); }
  size_t space() const { return cap_ - size(); }
  // Producer
  bool push(const float* data, size_t n) {
    if (space() < n) return false;
    uint64_t w = w_.load(std::memory_order_relaxed);
    for (size_t i = 0; i < n; i++) buf_[(w + i) % cap_] = data[i];
    w_.store(w + n, std::memory_order_release);
    return true;
  }
  // Consumer
  bool pop1(float& v) {
    uint64_t r = r_.load(std::memory_order_relaxed);
    if (w_.load(std::memory_order_acquire) == r) return false;
    v = buf_[r % cap_];
    r_.store(r + 1, std::memory_order_release);
    return true;
  }
  size_t pop(float* out, size_t n) {
    size_t avail = size();
    if (n > avail) n = avail;
    uint64_t r = r_.load(std::memory_order_relaxed);
    for (size_t i = 0; i < n; i++) out[i] = buf_[(r + i) % cap_];
    r_.store(r + n, std::memory_order_release);
    return n;
  }
  void clear() { r_.store(w_.load()); }

 private:
  std::vector<float> buf_;
  size_t cap_ = 1;
  std::atomic<uint64_t> w_{0};
  std::atomic<uint64_t> r_{0};
};

constexpr int kMaxChannels = 128;
constexpr unsigned int kTestDelay = 480;

struct Stream {
  unsigned int nIn = 0;
  unsigned int nOut = 0;
  unsigned int sampleRate = 48000;
  unsigned int bufferFrames = 256;
  // Captured frames: nIn inputs + the generator sample played, interleaved
  Ring capture;
  // Generator samples to play (mono)
  Ring output;
  std::atomic<uint8_t> outMask[kMaxChannels];
  std::atomic<uint64_t> played{0};    // frames played in total
  std::atomic<uint64_t> consumed{0};  // generator samples played
  std::atomic<uint64_t> silent{0};    // frames of silence played because the generator ring was empty
  std::atomic<uint32_t> underruns{0}; // callbacks with at least one silent frame (while the generator was running)
  std::atomic<uint32_t> overruns{0};  // callbacks whose input did not fit the capture ring (JS too slow)
  std::atomic<uint32_t> xruns{0};     // driver-reported over/underflows
  std::atomic<bool> primed{false};    // generator data has arrived at least once
  std::vector<float> frameBuf;
  // Notification to JavaScript (coalesced: one pending call at a time)
  Napi::ThreadSafeFunction notify;
  std::atomic<bool> notifyPending{false};
  std::atomic<bool> notifyOn{false};

  // Runs on the JavaScript thread. Calls can still be queued while the environment shuts down: ignore them then.
  static void callNotify(Napi::Env env, Napi::Function fn) {
    if (env == nullptr || fn.IsEmpty()) return;
    try {
      fn.Call({});
    } catch (const Napi::Error&) {
    }
  }

  void process(float* out, const float* in, unsigned int n, bool driverXrun) {
    const unsigned int stride = nIn + 1;
    if (frameBuf.size() < stride) frameBuf.resize(stride);
    bool under = false;
    for (unsigned int i = 0; i < n; i++) {
      float g = 0.0f;
      if (output.pop1(g)) {
        consumed.fetch_add(1, std::memory_order_relaxed);
      } else {
        g = 0.0f;
        silent.fetch_add(1, std::memory_order_relaxed);
        under = true;
      }
      if (out) {
        for (unsigned int c = 0; c < nOut; c++) out[i * nOut + c] = outMask[c].load(std::memory_order_relaxed) ? g : 0.0f;
      }
      for (unsigned int c = 0; c < nIn; c++) frameBuf[c] = in ? in[i * nIn + c] : 0.0f;
      frameBuf[nIn] = g;
      if (!capture.push(frameBuf.data(), stride)) {
        overruns.fetch_add(1, std::memory_order_relaxed);
        break;
      }
    }
    played.fetch_add(n, std::memory_order_relaxed);
    if (under && primed.load(std::memory_order_relaxed)) underruns.fetch_add(1, std::memory_order_relaxed);
    if (driverXrun) xruns.fetch_add(1, std::memory_order_relaxed);
    if (notifyOn.load(std::memory_order_acquire) && !notifyPending.exchange(true)) {
      notify.NonBlockingCall(&Stream::callNotify);
    }
  }
};

std::unique_ptr<RtAudio> gAudio;
std::unique_ptr<Stream> gStream;
std::string gLastError;
std::mutex gErrorMutex;
// Virtual test device
std::thread gTestThread;
std::atomic<bool> gTestRunning{false};
bool gTestOpen = false;

bool testEnabled() {
  const char* v = std::getenv("CAL_NATIVE_TEST");
  return v && std::string(v) == "1";
}

void setError(const std::string& msg) {
  std::lock_guard<std::mutex> lock(gErrorMutex);
  gLastError = msg;
}

std::string takeError() {
  std::lock_guard<std::mutex> lock(gErrorMutex);
  std::string e = gLastError;
  gLastError.clear();
  return e;
}

int rtCallback(void* outputBuffer, void* inputBuffer, unsigned int nFrames, double, RtAudioStreamStatus status, void* userData) {
  auto* s = static_cast<Stream*>(userData);
  s->process(static_cast<float*>(outputBuffer), static_cast<const float*>(inputBuffer), nFrames, status != 0);
  return 0;
}

RtAudio::Api apiByName(const std::string& name) {
#if defined(__WINDOWS_ASIO__)
  if (name == "asio") return RtAudio::WINDOWS_ASIO;
#endif
  (void)name;
  return RtAudio::RTAUDIO_DUMMY;
}

Napi::Value Apis(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  uint32_t i = 0;
#if defined(__WINDOWS_ASIO__)
  out.Set(i++, "asio");
#endif
  if (testEnabled()) out.Set(i++, "test");
  return out;
}

Napi::Object deviceObject(Napi::Env env, unsigned int id, const std::string& name, unsigned int in, unsigned int out, const std::vector<unsigned int>& rates, unsigned int preferred) {
  Napi::Object d = Napi::Object::New(env);
  d.Set("id", id);
  d.Set("name", name);
  d.Set("inputs", in);
  d.Set("outputs", out);
  Napi::Array r = Napi::Array::New(env, rates.size());
  for (size_t k = 0; k < rates.size(); k++) r.Set(static_cast<uint32_t>(k), rates[k]);
  d.Set("sampleRates", r);
  d.Set("preferredRate", preferred);
  return d;
}

// devices(api): the devices (drivers) of an API. Only while no stream is open (ASIO loads one driver at a time).
Napi::Value Devices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string api = info.Length() > 0 && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : "";
  Napi::Array out = Napi::Array::New(env);
  if (api == "test") {
    if (testEnabled()) out.Set(0u, deviceObject(env, 0, "Virtual loopback interface", 2, 2, {44100, 48000, 96000}, 48000));
    return out;
  }
  if (gStream) {
    Napi::Error::New(env, "Stop audio before listing devices").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  RtAudio::Api a = apiByName(api);
  if (a == RtAudio::RTAUDIO_DUMMY) return out;
  try {
    RtAudio probe(a, [](RtAudioErrorType, const std::string& msg) { setError(msg); });
    probe.showWarnings(false);
    uint32_t k = 0;
    for (unsigned int id : probe.getDeviceIds()) {
      RtAudio::DeviceInfo di = probe.getDeviceInfo(id);
      if (di.inputChannels == 0 && di.outputChannels == 0) continue;
      out.Set(k++, deviceObject(env, id, di.name, di.inputChannels, di.outputChannels, di.sampleRates, di.preferredSampleRate ? di.preferredSampleRate : di.currentSampleRate));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return out;
}

void closeAll() {
  if (gTestOpen) {
    gTestRunning.store(false);
    if (gTestThread.joinable()) gTestThread.join();
    gTestOpen = false;
  }
  if (gAudio) {
    try {
      if (gAudio->isStreamRunning()) gAudio->stopStream();
      if (gAudio->isStreamOpen()) gAudio->closeStream();
    } catch (...) {
    }
    gAudio.reset();
  }
  if (gStream) {
    gStream->notifyOn.store(false);
    gStream->notify.Release();
    gStream.reset();
  }
}

void testLoop(Stream* s) {
  const unsigned int n = s->bufferFrames;
  std::vector<float> out(n * s->nOut), in(n * s->nIn);
  std::vector<float> history(kTestDelay + n, 0.0f);
  uint32_t seed = 12345;
  auto next = std::chrono::steady_clock::now();
  const auto period = std::chrono::nanoseconds(static_cast<long long>(1e9 * n / s->sampleRate));
  while (gTestRunning.load()) {
    // history[0..D) holds the last D output samples: the input of this period is the output D samples ago
    // (input 1 at half level with a little noise, like a mic; input 2 unscaled, like a hardware loopback)
    for (unsigned int i = 0; i < n; i++) {
      seed = seed * 1664525u + 1013904223u;
      float noise = ((seed >> 9) / 8388608.0f - 1.0f) * 1e-4f;
      in[i * s->nIn + 0] = 0.5f * history[i] + noise;
      in[i * s->nIn + 1] = history[i];
    }
    s->process(out.data(), in.data(), n, false);
    // Append this period's output (the first output carrying the generator) and drop the oldest n samples
    for (unsigned int i = 0; i < n; i++) {
      float g = 0.0f;
      for (unsigned int c = 0; c < s->nOut; c++) {
        if (s->outMask[c].load()) {
          g = out[i * s->nOut + c];
          break;
        }
      }
      history[kTestDelay + i] = g;
    }
    std::memmove(history.data(), history.data() + n, kTestDelay * sizeof(float));
    next += period;
    std::this_thread::sleep_until(next);
  }
}

// open({ api, device, inputs, outputs, sampleRate, bufferFrames }, notify) → { sampleRate, bufferFrames, inputs, outputs, latency, name }
Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "open(options, notify)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  closeAll();
  Napi::Object o = info[0].As<Napi::Object>();
  std::string api = o.Get("api").ToString().Utf8Value();
  unsigned int device = o.Has("device") ? o.Get("device").ToNumber().Uint32Value() : 0;
  unsigned int wantIn = o.Has("inputs") ? o.Get("inputs").ToNumber().Uint32Value() : 0;
  unsigned int wantOut = o.Has("outputs") ? o.Get("outputs").ToNumber().Uint32Value() : 0;
  unsigned int rate = o.Has("sampleRate") ? o.Get("sampleRate").ToNumber().Uint32Value() : 48000;
  unsigned int frames = o.Has("bufferFrames") ? o.Get("bufferFrames").ToNumber().Uint32Value() : 256;

  auto s = std::make_unique<Stream>();
  for (auto& m : s->outMask) m.store(0);
  std::string name;
  if (api == "test") {
    if (!testEnabled()) {
      Napi::Error::New(env, "The virtual device is not enabled").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    s->nIn = 2;
    s->nOut = 2;
    s->sampleRate = rate ? rate : 48000;
    // The delay line needs buffers no longer than the simulated delay
    s->bufferFrames = frames ? std::min(frames, kTestDelay) : 256;
    name = "Virtual loopback interface";
  } else {
    RtAudio::Api a = apiByName(api);
    if (a == RtAudio::RTAUDIO_DUMMY) {
      Napi::Error::New(env, "This audio API is not available in this build").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      gAudio = std::make_unique<RtAudio>(a, [](RtAudioErrorType, const std::string& msg) { setError(msg); });
      gAudio->showWarnings(false);
      RtAudio::DeviceInfo di = gAudio->getDeviceInfo(device);
      name = di.name;
      s->nIn = wantIn ? std::min(wantIn, di.inputChannels) : di.inputChannels;
      s->nOut = wantOut ? std::min(wantOut, di.outputChannels) : di.outputChannels;
      if (s->nIn > kMaxChannels) s->nIn = kMaxChannels;
      if (s->nOut > kMaxChannels) s->nOut = kMaxChannels;
      if (s->nIn == 0 && s->nOut == 0) throw std::runtime_error("The device has no inputs or outputs");
    } catch (const std::exception& e) {
      gAudio.reset();
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  // Two seconds of capture, one second of generator
  s->capture.reset(static_cast<size_t>(s->sampleRate * 2) * (s->nIn + 1));
  s->output.reset(s->sampleRate);
  s->notify = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "cal-audio-notify", 0, 1);
  s->notify.Unref(env);

  if (api == "test") {
    gStream = std::move(s);
    gTestOpen = true;
  } else {
    RtAudio::StreamParameters ip, op;
    ip.deviceId = op.deviceId = device;
    ip.nChannels = s->nIn;
    op.nChannels = s->nOut;
    RtAudio::StreamOptions opts;
    opts.flags = RTAUDIO_SCHEDULE_REALTIME;
    opts.streamName = "CAL Audio Analyzer";
    unsigned int bf = frames;
    Stream* raw = s.get();
    RtAudioErrorType err = gAudio->openStream(s->nOut ? &op : nullptr, s->nIn ? &ip : nullptr, RTAUDIO_FLOAT32, rate, &bf, &rtCallback, raw, &opts);
    if (err != RTAUDIO_NO_ERROR) {
      std::string msg = takeError();
      s->notify.Release();
      gAudio.reset();
      Napi::Error::New(env, msg.empty() ? "Could not open the audio device" : msg).ThrowAsJavaScriptException();
      return env.Undefined();
    }
    s->bufferFrames = bf;
    s->sampleRate = gAudio->getStreamSampleRate();
    gStream = std::move(s);
  }
  Napi::Object r = Napi::Object::New(env);
  r.Set("sampleRate", gStream->sampleRate);
  r.Set("bufferFrames", gStream->bufferFrames);
  r.Set("inputs", gStream->nIn);
  r.Set("outputs", gStream->nOut);
  r.Set("latency", gAudio ? static_cast<double>(gAudio->getStreamLatency()) : static_cast<double>(gStream->bufferFrames));
  r.Set("name", name);
  return r;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gStream) {
    Napi::Error::New(env, "No stream open").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  gStream->notifyOn.store(true);
  if (gTestOpen) {
    gTestRunning.store(true);
    gTestThread = std::thread(testLoop, gStream.get());
    return env.Undefined();
  }
  if (gAudio->startStream() != RTAUDIO_NO_ERROR) {
    std::string msg = takeError();
    Napi::Error::New(env, msg.empty() ? "Could not start the audio device" : msg).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  closeAll();
  return info.Env().Undefined();
}

// read() → { data: Float32Array (frames × (inputs + 1)), frames, played, consumed, silent, underruns, overruns, xruns, queued }
Napi::Value Read(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gStream) return env.Null();
  Stream* s = gStream.get();
  s->notifyPending.store(false);
  const size_t stride = s->nIn + 1;
  const size_t frames = s->capture.size() / stride;
  Napi::Float32Array data = Napi::Float32Array::New(env, frames * stride);
  s->capture.pop(data.Data(), frames * stride);
  Napi::Object r = Napi::Object::New(env);
  r.Set("data", data);
  r.Set("frames", static_cast<double>(frames));
  r.Set("played", static_cast<double>(s->played.load()));
  r.Set("consumed", static_cast<double>(s->consumed.load()));
  r.Set("silent", static_cast<double>(s->silent.load()));
  r.Set("underruns", s->underruns.load());
  r.Set("overruns", s->overruns.load());
  r.Set("xruns", s->xruns.load());
  r.Set("queued", static_cast<double>(s->output.size()));
  return r;
}

// write(Float32Array) → samples accepted (the generator signal, mono)
Napi::Value Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gStream || info.Length() < 1 || !info[0].IsTypedArray()) return Napi::Number::New(env, 0);
  Napi::Float32Array a = info[0].As<Napi::Float32Array>();
  size_t n = std::min(a.ElementLength(), gStream->output.space());
  gStream->output.push(a.Data(), n);
  if (n) gStream->primed.store(true);
  return Napi::Number::New(env, static_cast<double>(n));
}

// setOutputs([indices]): output channels that carry the generator
Napi::Value SetOutputs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gStream || info.Length() < 1 || !info[0].IsArray()) return env.Undefined();
  Napi::Array a = info[0].As<Napi::Array>();
  for (auto& m : gStream->outMask) m.store(0);
  for (uint32_t i = 0; i < a.Length(); i++) {
    uint32_t c = a.Get(i).ToNumber().Uint32Value();
    if (c < kMaxChannels) gStream->outMask[c].store(1);
  }
  return env.Undefined();
}

// clearOutput(): drop generator samples not yet played (e.g. stop a sweep at once)
Napi::Value ClearOutput(const Napi::CallbackInfo& info) {
  if (gStream) gStream->output.clear();
  return info.Env().Undefined();
}

// controlPanel(): open the ASIO driver's own settings window (buffer size, clock source…)
Napi::Value ControlPanel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#if defined(__WINDOWS_ASIO__)
  if (gAudio && gAudio->isStreamOpen()) return Napi::Boolean::New(env, ASIOControlPanel() == ASE_OK);
#endif
  return Napi::Boolean::New(env, false);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("apis", Napi::Function::New(env, Apis));
  exports.Set("devices", Napi::Function::New(env, Devices));
  exports.Set("open", Napi::Function::New(env, Open));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("read", Napi::Function::New(env, Read));
  exports.Set("write", Napi::Function::New(env, Write));
  exports.Set("setOutputs", Napi::Function::New(env, SetOutputs));
  exports.Set("clearOutput", Napi::Function::New(env, ClearOutput));
  exports.Set("controlPanel", Napi::Function::New(env, ControlPanel));
  exports.Set("version", Napi::String::New(env, RtAudio::getVersion()));
  env.AddCleanupHook([]() { closeAll(); });
  return exports;
}

}  // namespace

NODE_API_MODULE(cal_audio, Init)
