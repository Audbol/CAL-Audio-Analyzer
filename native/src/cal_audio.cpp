// CAL Audio Analyzer native audio I/O for the desktop app: ASIO on Windows, Core Audio on macOS, JACK (also
// PipeWire's JACK layer) and ALSA on Linux.
//
// The audio callback runs on the driver's thread and never waits for JavaScript:
//  - output: the generator signal (mono) is taken from a lock-free ring filled ahead by JavaScript and written
//    to the selected output channels; when the ring runs dry, silence is played;
//  - input: every input frame is stored together with the generator sample that was actually played in the
//    same callback (silence included), so the internal reference stays sample-aligned with the inputs even
//    if JavaScript falls behind.
// JavaScript is woken after each callback (coalesced) and reads the captured frames with read().
//
// Input and output can be two devices (e.g. a USB microphone and the built-in speakers). They run on their own
// clocks, so each has its own stream: the output callback queues the generator samples it played, the input
// callback pairs every captured frame with the next one, and a slow servo drops or repeats a single sample when
// the queue drifts by a sample or more, so the reference follows the clocks' drift instead of slipping a whole
// buffer. (JACK / PipeWire devices share the server's clock: one stream.)
//
// A built-in virtual device ("test" API, enabled with CAL_NATIVE_TEST=1) runs the same path without
// hardware: input 1 is the output delayed by 480 samples, input 2 is a direct loopback. Its second device is an
// output on a separate clock (500 ppm apart), for the two-device path: the loopback inputs then hear it 2400
// samples later, resampled to the input's clock.

#include <napi.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
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
#if defined(__LINUX_ALSA__)
#include <alsa/asoundlib.h>
#endif

// JACK is loaded at run time (jack_loader.cpp): true when libjack or pipewire-jack is installed
bool calJackLoad();

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
  // Two devices (split): generator samples played, in order, waiting to be paired with captured frames
  bool split = false;
  unsigned int outBufferFrames = 256;
  Ring loop;
  std::vector<float> outBuf;
  std::atomic<uint64_t> loopPushed{0};
  std::atomic<int64_t> outTime{0};  // steady clock (ns) of the last output callback
  std::atomic<uint32_t> outSeq{0};  // seqlock for loopPushed + outTime
  // How far the capture timeline is from the play timeline: frames padded or repeated (+), samples dropped and
  // frames lost to a full capture ring or queue (−). One device: only the lost frames.
  std::atomic<int64_t> shift{0};
  // The servo's net correction (samples dropped − repeated) for the clocks' drift: larger steps (over 0.5 % of a
  // window) realign after a stall or dropout and aren't drift, so they aren't counted
  std::atomic<int64_t> drift{0};
  std::atomic<uint64_t> inFrames{0};
  // Input thread only
  uint64_t loopPopped = 0;
  bool loopStarted = false;
  unsigned int repeat = 0;
  uint64_t owed = 0;  // frames padded while the queue was empty (the output stalled): dropped once it catches up
  float lastG = 0.0f;
  std::array<double, 2048> winLevels{};
  size_t winCount = 0;
  uint64_t winFrames = 0;
  int windows = 0;
  double driftRate = 0;  // samples to drop (+) or repeat (−) per input frame
  double driftAcc = 0;
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
    bool under = false, full = false;
    int64_t lost = 0;
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
      // A full capture ring (JavaScript fell behind): the frame is lost, but the output carries on
      if (!full && !capture.push(frameBuf.data(), stride)) {
        overruns.fetch_add(1, std::memory_order_relaxed);
        full = true;
      }
      if (full) lost++;
    }
    // Frames not captured: later generator samples are captured that much earlier
    if (lost) shift.fetch_sub(lost, std::memory_order_relaxed);
    played.fetch_add(n, std::memory_order_relaxed);
    if (under && primed.load(std::memory_order_relaxed)) underruns.fetch_add(1, std::memory_order_relaxed);
    if (driverXrun) xruns.fetch_add(1, std::memory_order_relaxed);
    wake();
  }

  void wake() {
    if (notifyOn.load(std::memory_order_acquire) && !notifyPending.exchange(true)) {
      notify.NonBlockingCall(&Stream::callNotify);
    }
  }

  // The virtual two-device setup keeps its own (simulated hardware) time: it sets simTime before each callback
  std::atomic<int64_t> simTime{-1};
  int64_t nowNs() const {
    int64_t t = simTime.load(std::memory_order_relaxed);
    if (t >= 0) return t;
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
  }

  // Two devices, output side: play the generator and queue what was played
  void processOut(float* out, unsigned int n, bool driverXrun) {
    if (outBuf.size() < n) outBuf.resize(n);
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
      outBuf[i] = g;
    }
    // A full queue means the input stopped: what doesn't fit is dropped (the servo realigns when it resumes)
    bool queued = loop.push(outBuf.data(), n);
    outSeq.fetch_add(1, std::memory_order_acq_rel);
    if (queued) loopPushed.fetch_add(n, std::memory_order_relaxed);
    // Not queued (the input stopped): these samples are never captured, so later ones are captured n earlier
    else shift.fetch_sub(n, std::memory_order_relaxed);
    outTime.store(nowNs(), std::memory_order_relaxed);
    outSeq.fetch_add(1, std::memory_order_release);
    played.fetch_add(n, std::memory_order_relaxed);
    if (under && primed.load(std::memory_order_relaxed)) underruns.fetch_add(1, std::memory_order_relaxed);
    if (driverXrun) xruns.fetch_add(1, std::memory_order_relaxed);
  }

  // Two devices, input side: pair each captured frame with the next played sample, then follow the drift
  void processIn(const float* in, unsigned int n, bool driverXrun) {
    const unsigned int stride = nIn + 1;
    if (frameBuf.size() < stride) frameBuf.resize(stride);
    // Start pairing once a few buffers are queued, so callback jitter never empties the queue
    if (!loopStarted && loop.size() >= 2 * static_cast<size_t>(n + outBufferFrames)) loopStarted = true;
    int64_t added = 0, lost = 0;
    bool full = false;
    for (unsigned int i = 0; i < n; i++) {
      float g = 0.0f;
      if (repeat) {
        repeat--;
        g = lastG;
        added++;
      } else if (loopStarted && loop.pop1(g)) {
        loopPopped++;
        lastG = g;
      } else {
        g = 0.0f;
        added++;
        if (loopStarted) owed++;
      }
      for (unsigned int c = 0; c < nIn; c++) frameBuf[c] = in ? in[i * nIn + c] : 0.0f;
      frameBuf[nIn] = g;
      // A full capture ring (JavaScript fell behind): the frame is lost, but the output carries on
      if (!full && !capture.push(frameBuf.data(), stride)) {
        overruns.fetch_add(1, std::memory_order_relaxed);
        full = true;
      }
      if (full) lost++;
    }
    // Frames not captured: later generator samples are captured that much earlier
    if (lost) shift.fetch_sub(lost, std::memory_order_relaxed);
    if (added) shift.fetch_add(added, std::memory_order_relaxed);
    // After an output stall: as soon as it catches up, skip what it played while the input had nothing to pair
    // (the reference lines up again at once instead of at the next servo window)
    if (owed) {
      const size_t keep = n + outBufferFrames;
      const size_t size = loop.size();
      if (size > keep) {
        uint64_t k = std::min<uint64_t>(owed, size - keep);
        owed -= k;
        correct(static_cast<int>(k), false);
      }
    }
    inFrames.fetch_add(n, std::memory_order_relaxed);
    if (driverXrun) xruns.fetch_add(1, std::memory_order_relaxed);
    if (loopStarted) servo(n);
    wake();
  }

  // Drop k samples from the queue (k > 0: the output runs ahead) or repeat the last one (k < 0: the input runs ahead)
  void correct(int k, bool isDrift) {
    if (k > 0) {
      int dropped = 0;
      float d;
      while (dropped < k && loop.pop1(d)) {
        loopPopped++;
        dropped++;
      }
      shift.fetch_sub(dropped, std::memory_order_relaxed);
      if (isDrift) drift.fetch_add(dropped, std::memory_order_relaxed);
    } else if (k < 0) {
      repeat += static_cast<unsigned int>(-k);
      if (isDrift) drift.fetch_add(k, std::memory_order_relaxed);
    }
  }

  // The queue's level, read between output callbacks as if the output played continuously, stays constant
  // while both clocks agree. It is held at one buffer of each device: enough that the queue never runs dry, and
  // the reference then lines up with what is heard about as closely as on one device (whose input and output
  // latencies are part of every measured delay).
  //  - The drift rate is learnt, and corrected a sample at a time as it accrues (so the reference stays within
  //    about a sample, however far apart the clocks run).
  //  - Over each quarter second the median level counts (a stalled callback can't move it): its whole-sample
  //    error is corrected at once and refines the rate. The first window only settles.
  void servo(unsigned int n) {
    // Corrections for the drift as it accrues
    driftAcc += driftRate * n;
    if (driftAcc >= 1.0 || driftAcc <= -1.0) {
      int k = static_cast<int>(driftAcc);
      driftAcc -= k;
      correct(k, true);
    }
    uint32_t s1, s2;
    uint64_t pushed;
    int64_t t;
    do {
      s1 = outSeq.load(std::memory_order_acquire);
      pushed = loopPushed.load(std::memory_order_relaxed);
      t = outTime.load(std::memory_order_relaxed);
      std::atomic_thread_fence(std::memory_order_acquire);
      s2 = outSeq.load(std::memory_order_relaxed);
    } while (s1 != s2 || (s1 & 1));
    double since = t ? (nowNs() - t) * 1e-9 * sampleRate : 0.0;
    if (since < 0) since = 0;
    if (since > outBufferFrames) since = outBufferFrames;
    // (Repeats still pending count as done)
    if (winCount < winLevels.size()) winLevels[winCount++] = static_cast<double>(pushed) + since - static_cast<double>(loopPopped) + repeat;
    winFrames += n;
    if (winFrames < sampleRate / 4) return;
    auto mid = winLevels.begin() + winCount / 2;
    std::nth_element(winLevels.begin(), mid, winLevels.begin() + winCount);
    double level = *mid;
    const double frames = static_cast<double>(winFrames);
    winCount = 0;
    winFrames = 0;
    if (++windows < 2) return;
    double e = level - static_cast<double>(n + outBufferFrames);
    // Larger steps (over 0.5 % of a window) realign after a stall or dropout: not drift
    const bool isDrift = std::abs(e) <= frames / 200.0;
    if (isDrift) {
      // The median sits mid-window, with half the window's drift: half of it refines the rate, by at most 1.5
      // samples a window (125 ppm at 48 kHz), so a disturbance can't throw the rate off
      driftRate += std::max(-1.5, std::min(1.5, 0.5 * e)) / frames;
      if (driftRate > 0.005) driftRate = 0.005;
      if (driftRate < -0.005) driftRate = -0.005;
    }
    if (e >= 1.0 || e <= -1.0) correct(static_cast<int>(e), isDrift);
  }
};

std::unique_ptr<RtAudio> gAudio;
std::unique_ptr<RtAudio> gAudioOut;  // the output device's stream, when input and output are two devices
std::unique_ptr<Stream> gStream;
std::string gLastError;
std::mutex gErrorMutex;
// Virtual test device
std::thread gTestThread;
std::atomic<bool> gTestRunning{false};
bool gTestOpen = false;
constexpr unsigned int kTestSplitDelay = 2400;
constexpr double kTestSplitRatio = 1.0005;  // output samples per input sample (the clocks 500 ppm apart)

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

int rtOutCallback(void* outputBuffer, void*, unsigned int nFrames, double, RtAudioStreamStatus status, void* userData) {
  static_cast<Stream*>(userData)->processOut(static_cast<float*>(outputBuffer), nFrames, status != 0);
  return 0;
}

int rtInCallback(void*, void* inputBuffer, unsigned int nFrames, double, RtAudioStreamStatus status, void* userData) {
  static_cast<Stream*>(userData)->processIn(static_cast<const float*>(inputBuffer), nFrames, status != 0);
  return 0;
}

RtAudio::Api apiByName(const std::string& name) {
#if defined(__WINDOWS_ASIO__)
  if (name == "asio") return RtAudio::WINDOWS_ASIO;
#endif
#if defined(__MACOSX_CORE__)
  if (name == "core") return RtAudio::MACOSX_CORE;
#endif
#if defined(__UNIX_JACK__)
  if (name == "jack" && calJackLoad()) return RtAudio::UNIX_JACK;
#endif
#if defined(__LINUX_ALSA__)
  if (name == "alsa") return RtAudio::LINUX_ALSA;
#endif
  (void)name;
  return RtAudio::RTAUDIO_DUMMY;
}

// apis(): the native audio APIs this build offers on this computer, in order of preference
Napi::Value Apis(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  uint32_t i = 0;
#if defined(__WINDOWS_ASIO__)
  out.Set(i++, "asio");
#endif
#if defined(__MACOSX_CORE__)
  out.Set(i++, "core");
#endif
#if defined(__UNIX_JACK__)
  if (calJackLoad()) out.Set(i++, "jack");
#endif
#if defined(__LINUX_ALSA__)
  out.Set(i++, "alsa");
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
    if (testEnabled()) {
      out.Set(0u, deviceObject(env, 0, "Virtual loopback interface", 2, 2, {44100, 48000, 96000}, 48000));
      out.Set(1u, deviceObject(env, 1, "Virtual speakers (separate clock)", 0, 2, {44100, 48000, 96000}, 48000));
    }
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
  for (auto* a : {&gAudio, &gAudioOut}) {
    if (!*a) continue;
    try {
      if ((*a)->isStreamRunning()) (*a)->stopStream();
      if ((*a)->isStreamOpen()) (*a)->closeStream();
    } catch (...) {
    }
    a->reset();
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

// The virtual two-device setup: the speakers' output goes into the "air" (indexed by output sample), and the
// loopback interface's inputs hear it kTestSplitDelay samples later on their own, slower clock (interpolated).
// Both devices run in one thread on simulated hardware time: each callback comes at its device's own time (the
// output's at the start of the buffer it plays, the input's at the end of the buffer it captured), in that
// order, paced to the wall clock. A late thread delays them all alike, so the test is about the servo, not
// about how busy the computer is.
void testSplitLoop(Stream* s) {
  const unsigned int nOutF = s->outBufferFrames, nInF = s->bufferFrames;
  const double fs = s->sampleRate;
  std::vector<float> out(nOutF * s->nOut), in(nInF * s->nIn);
  std::vector<float> air(1 << 16, 0.0f);
  const size_t mask = air.size() - 1;
  uint64_t written = 0, captured = 0;
  uint32_t seed = 12345;
  const double inStart = 0.003;  // the input starts 3 ms after the output
  auto sample = [&](double pos) -> float {
    if (pos < 0) return 0.0f;
    uint64_t i = static_cast<uint64_t>(pos);
    double f = pos - static_cast<double>(i);
    if (i + 1 >= written || written - i >= air.size()) return 0.0f;
    return static_cast<float>(air[i & mask] * (1 - f) + air[(i + 1) & mask] * f);
  };
  const auto t0 = std::chrono::steady_clock::now();
  while (gTestRunning.load()) {
    const double tOut = written / fs;
    const double tIn = inStart + (captured + nInF) * kTestSplitRatio / fs;
    const bool outFirst = tOut <= tIn;
    const double t = outFirst ? tOut : tIn;
    std::this_thread::sleep_until(t0 + std::chrono::nanoseconds(static_cast<long long>(t * 1e9)));
    s->simTime.store(static_cast<int64_t>(t * 1e9), std::memory_order_relaxed);
    if (outFirst) {
      s->processOut(out.data(), nOutF, false);
      for (unsigned int i = 0; i < nOutF; i++) {
        float g = 0.0f;
        for (unsigned int c = 0; c < s->nOut; c++) {
          if (s->outMask[c].load()) {
            g = out[i * s->nOut + c];
            break;
          }
        }
        air[(written + i) & mask] = g;
      }
      written += nOutF;
    } else {
      // Input frame k is captured at inStart + k periods of its clock: it hears the output sample of that moment
      for (unsigned int i = 0; i < nInF; i++) {
        double pos = (inStart + (captured + i) * kTestSplitRatio / fs) * fs - kTestSplitDelay;
        float v = sample(pos);
        seed = seed * 1664525u + 1013904223u;
        float noise = ((seed >> 9) / 8388608.0f - 1.0f) * 1e-4f;
        in[i * s->nIn + 0] = 0.5f * v + noise;
        in[i * s->nIn + 1] = v;
      }
      captured += nInF;
      s->processIn(in.data(), nInF, false);
    }
  }
}

// open({ api, device, outputDevice?, inputs, outputs, sampleRate, bufferFrames }, notify)
//   → { sampleRate, bufferFrames, inputs, outputs, latency, name, outputName, split }
// outputDevice: another device for the outputs (the generator); omitted or equal to device: one device.
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
  unsigned int outDevice = o.Has("outputDevice") && o.Get("outputDevice").IsNumber() ? o.Get("outputDevice").ToNumber().Uint32Value() : device;
  unsigned int wantIn = o.Has("inputs") ? o.Get("inputs").ToNumber().Uint32Value() : 0;
  unsigned int wantOut = o.Has("outputs") ? o.Get("outputs").ToNumber().Uint32Value() : 0;
  unsigned int rate = o.Has("sampleRate") ? o.Get("sampleRate").ToNumber().Uint32Value() : 48000;
  unsigned int frames = o.Has("bufferFrames") ? o.Get("bufferFrames").ToNumber().Uint32Value() : 256;
  const bool twoDevices = outDevice != device;
  // JACK / PipeWire devices all run on the server's clock: one stream across both
  const bool split = twoDevices && api != "jack";

  auto s = std::make_unique<Stream>();
  for (auto& m : s->outMask) m.store(0);
  std::string name, outName;
  auto fail = [&](const std::string& msg) {
    gAudio.reset();
    gAudioOut.reset();
    Napi::Error::New(env, msg).ThrowAsJavaScriptException();
    return env.Undefined();
  };
  if (api == "test") {
    if (!testEnabled()) return fail("The virtual device is not enabled");
    if (device != 0 || outDevice > 1) return fail("The virtual interface has no such device");
    s->nIn = 2;
    s->nOut = 2;
    s->sampleRate = rate ? rate : 48000;
    // The delay line needs buffers no longer than the simulated delay
    s->bufferFrames = frames ? std::min(frames, kTestDelay) : 256;
    s->outBufferFrames = s->bufferFrames;
    s->split = split;
    name = "Virtual loopback interface";
    outName = split ? "Virtual speakers (separate clock)" : name;
  } else {
    RtAudio::Api a = apiByName(api);
    if (a == RtAudio::RTAUDIO_DUMMY) return fail("This audio API is not available in this build");
    if (twoDevices && api == "asio") return fail("ASIO opens one driver for both input and output: choose the same device for the output");
    try {
      gAudio = std::make_unique<RtAudio>(a, [](RtAudioErrorType, const std::string& msg) { setError(msg); });
      gAudio->showWarnings(false);
      RtAudio::DeviceInfo di = gAudio->getDeviceInfo(device);
      RtAudio::DeviceInfo dout = twoDevices ? gAudio->getDeviceInfo(outDevice) : di;
      if (dout.name.empty() && twoDevices) throw std::runtime_error("The output device was not found");
      name = di.name;
      outName = dout.name;
      s->nIn = wantIn ? std::min(wantIn, di.inputChannels) : di.inputChannels;
      s->nOut = wantOut ? std::min(wantOut, dout.outputChannels) : dout.outputChannels;
      if (s->nIn > kMaxChannels) s->nIn = kMaxChannels;
      if (s->nOut > kMaxChannels) s->nOut = kMaxChannels;
      if (s->nIn == 0 && s->nOut == 0) throw std::runtime_error("The device has no inputs or outputs");
      if (twoDevices && s->nIn == 0) throw std::runtime_error("The input device has no inputs");
      if (twoDevices && s->nOut == 0) throw std::runtime_error("The output device has no outputs");
    } catch (const std::exception& e) {
      return fail(e.what());
    }
  }
  // Two seconds of capture, one second of generator
  s->capture.reset(static_cast<size_t>(s->sampleRate * 2) * (s->nIn + 1));
  s->output.reset(s->sampleRate);
  if (split) {
    s->split = true;
    s->loop.reset(s->sampleRate);
    // Sized ahead, so the audio callbacks don't allocate
    s->outBuf.resize(8192);
    s->frameBuf.resize(s->nIn + 1);
  }
  s->notify = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "cal-audio-notify", 0, 1);
  s->notify.Unref(env);

  double latency = 0;
  if (api == "test") {
    gStream = std::move(s);
    gTestOpen = true;
    latency = gStream->bufferFrames;
  } else {
    RtAudio::StreamOptions opts;
    opts.flags = RTAUDIO_SCHEDULE_REALTIME;
    opts.streamName = "CAL Audio Analyzer";
    Stream* raw = s.get();
    auto openErr = [&](const char* fallback) {
      std::string msg = takeError();
      s->notify.Release();
      return fail(msg.empty() ? fallback : msg);
    };
    if (!split) {
      RtAudio::StreamParameters ip, op;
      ip.deviceId = device;
      op.deviceId = outDevice;
      ip.nChannels = s->nIn;
      op.nChannels = s->nOut;
      unsigned int bf = frames;
      RtAudioErrorType err = gAudio->openStream(s->nOut ? &op : nullptr, s->nIn ? &ip : nullptr, RTAUDIO_FLOAT32, rate, &bf, &rtCallback, raw, &opts);
      if (err != RTAUDIO_NO_ERROR) return openErr("Could not open the audio device");
      s->bufferFrames = bf;
      s->sampleRate = gAudio->getStreamSampleRate();
      latency = static_cast<double>(gAudio->getStreamLatency());
    } else {
      // Output first: its rate is the one the input must match
      gAudioOut = std::make_unique<RtAudio>(apiByName(api), [](RtAudioErrorType, const std::string& msg) { setError(msg); });
      gAudioOut->showWarnings(false);
      RtAudio::StreamParameters ip, op;
      op.deviceId = outDevice;
      op.nChannels = s->nOut;
      ip.deviceId = device;
      ip.nChannels = s->nIn;
      unsigned int bfo = frames;
      opts.streamName = "CAL Audio Analyzer (output)";
      if (gAudioOut->openStream(&op, nullptr, RTAUDIO_FLOAT32, rate, &bfo, &rtOutCallback, raw, &opts) != RTAUDIO_NO_ERROR) return openErr("Could not open the output device");
      unsigned int bfi = frames;
      RtAudio::StreamOptions iopts = opts;
      iopts.streamName = "CAL Audio Analyzer (input)";
      if (gAudio->openStream(nullptr, &ip, RTAUDIO_FLOAT32, rate, &bfi, &rtInCallback, raw, &iopts) != RTAUDIO_NO_ERROR) return openErr("Could not open the input device");
      unsigned int ri = gAudio->getStreamSampleRate(), ro = gAudioOut->getStreamSampleRate();
      if (ri != ro) {
        s->notify.Release();
        return fail("The input device runs at " + std::to_string(ri) + " Hz and the output device at " + std::to_string(ro) + " Hz: set both to the same rate");
      }
      s->bufferFrames = bfi;
      s->outBufferFrames = bfo;
      s->sampleRate = ri;
      latency = static_cast<double>(gAudio->getStreamLatency()) + static_cast<double>(gAudioOut->getStreamLatency());
    }
    gStream = std::move(s);
  }
  Napi::Object r = Napi::Object::New(env);
  r.Set("sampleRate", gStream->sampleRate);
  r.Set("bufferFrames", gStream->bufferFrames);
  r.Set("inputs", gStream->nIn);
  r.Set("outputs", gStream->nOut);
  r.Set("latency", latency);
  r.Set("name", name);
  r.Set("outputName", outName);
  r.Set("split", gStream->split);
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
    if (gStream->split) {
      gTestThread = std::thread(testSplitLoop, gStream.get());
    } else {
      gTestThread = std::thread(testLoop, gStream.get());
    }
    return env.Undefined();
  }
  if ((gAudioOut && gAudioOut->startStream() != RTAUDIO_NO_ERROR) || gAudio->startStream() != RTAUDIO_NO_ERROR) {
    std::string msg = takeError();
    // Nothing half-started: an output already running stops with the rest
    closeAll();
    Napi::Error::New(env, msg.empty() ? "Could not start the audio device" : msg).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  closeAll();
  return info.Env().Undefined();
}

// read() → { data: Float32Array (frames × (inputs + 1)), frames, played, consumed, silent, underruns, overruns, xruns, queued, drift, inputFrames }
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
  // A generator sample g is captured with frame g + silent + shift: played at frame g + silent, and shift for
  // frames lost to a full ring and (two devices) padded, repeated or dropped between the devices
  r.Set("silent", static_cast<double>(static_cast<int64_t>(s->silent.load()) + s->shift.load()));
  r.Set("drift", static_cast<double>(s->drift.load()));
  r.Set("inputFrames", static_cast<double>(s->split ? s->inFrames.load() : s->played.load()));
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

#if defined(__LINUX_ALSA__)
// ALSA prints its probing (missing cards, no PulseAudio, …) to stderr: errors reach the app through RtAudio instead
void alsaQuiet(const char*, int, const char*, int, const char*, ...) {}
#endif

Napi::Object Init(Napi::Env env, Napi::Object exports) {
#if defined(__LINUX_ALSA__)
  snd_lib_error_set_handler(&alsaQuiet);
#endif
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
