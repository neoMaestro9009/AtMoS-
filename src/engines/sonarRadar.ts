// src/engines/sonarRadar.ts
// SpatialRadar — رادار الحماية المكانية بتقنية Doppler السمعية
// إصلاح: Fade-in/out لمنع Audio Clipping + رفع عتبة الكشف

export type MotionType = "hand" | "body" | "unknown";

export interface RadarEvent {
  motionIntensity: number;
  motionType: MotionType;
  timestamp: number;
}

export class SpatialRadar {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gainNode: GainNode | null = null;      // ✅ Gain envelope for fade
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private rafId: number | null = null;

  private readonly FREQ = 19000;
  private baselineEnergy = 0;
  private baselineVariance = 0;                  // ✅ Variance for adaptive threshold
  private isCalibrating = true;
  private calibrationFrames = 0;
  private calibrationSamples: number[] = [];     // ✅ Store samples for variance calc
  private lastAlertTime = 0;
  private readonly ALERT_COOLDOWN_MS = 3000;
  // ✅ Raised from 3.0 to 5.5 — filters mic static / room noise
  private readonly MOTION_THRESHOLD = 5.5;

  private onMotionDetected: (event: RadarEvent) => void;
  private onCalibrationDone?: () => void;

  constructor(
    onMotionDetected: (event: RadarEvent) => void,
    onCalibrationDone?: () => void
  ) {
    this.onMotionDetected = onMotionDetected;
    this.onCalibrationDone = onCalibrationDone;
  }

  async start(): Promise<void> {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      console.error("SpatialRadar: Mic access denied", err);
      throw new Error("تعذّر الوصول إلى الميكروفون للرادار المكاني");
    }

    const source = this.ctx.createMediaStreamSource(this.micStream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.2;   // ✅ Slightly more smoothing
    source.connect(this.analyser);

    // ── Oscillator with Gain Envelope ─────────────────────────────
    this.osc = this.ctx.createOscillator();
    this.osc.type = "sine";
    this.osc.frequency.value = this.FREQ;

    // ✅ GainNode: fade in over 200ms → no click/pop
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
    this.gainNode.gain.linearRampToValueAtTime(0.65, this.ctx.currentTime + 0.2);

    this.osc.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
    this.osc.start();

    this.isCalibrating = true;
    this.calibrationFrames = 0;
    this.baselineEnergy = 0;
    this.calibrationSamples = [];
    this.scanLoop();
    console.log("AtMoS SpatialRadar: Active at 19kHz");
  }

  private getMotionEnergy(dataArray: Float32Array, targetBin: number, width: number): number {
    let energy = 0;
    for (let i = 1; i <= width; i++) {
      const bL = targetBin - i;
      const bR = targetBin + i;
      if (bL >= 0)               energy += Math.pow(10, dataArray[bL] / 10);
      if (bR < dataArray.length) energy += Math.pow(10, dataArray[bR] / 10);
    }
    return energy;
  }

  private scanLoop(): void {
    if (!this.analyser || !this.ctx) return;

    const dataArray = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(dataArray);

    const nyquist = this.ctx.sampleRate / 2;
    const binSize = nyquist / this.analyser.frequencyBinCount;
    const targetBin = Math.round(this.FREQ / binSize);
    const sidebandWidth = 8;

    const motionEnergy = this.getMotionEnergy(dataArray, targetBin, sidebandWidth);

    if (this.isCalibrating) {
      this.calibrationSamples.push(motionEnergy);
      this.baselineEnergy =
        (this.baselineEnergy * this.calibrationFrames + motionEnergy) /
        (this.calibrationFrames + 1);
      this.calibrationFrames++;

      if (this.calibrationFrames > 150) {               // ✅ 150 frames (~2.5s) for stable baseline
        // ✅ Compute baseline variance to set adaptive threshold
        const mean = this.baselineEnergy;
        const variance =
          this.calibrationSamples.reduce((s, v) => s + Math.pow(v - mean, 2), 0) /
          this.calibrationSamples.length;
        this.baselineVariance = Math.sqrt(variance);

        this.isCalibrating = false;
        console.log(
          "AtMoS SpatialRadar: Calibrated. Baseline:",
          this.baselineEnergy.toFixed(4),
          "StdDev:", this.baselineVariance.toFixed(4)
        );
        this.onCalibrationDone?.();
      }
    } else {
      const motionRatio = motionEnergy / (this.baselineEnergy + 1e-9);
      // ✅ Adaptive threshold: must exceed both fixed ratio AND 4σ above baseline noise
      const adaptiveThreshold = Math.max(
        this.MOTION_THRESHOLD,
        1 + (4 * this.baselineVariance) / (this.baselineEnergy + 1e-9)
      );

      const now = Date.now();
      if (motionRatio > adaptiveThreshold && now - this.lastAlertTime > this.ALERT_COOLDOWN_MS) {
        this.lastAlertTime = now;

        const nearBinCount = 3;
        const nearEnergy = this.getMotionEnergy(dataArray, targetBin, nearBinCount);
        const nearRatio = nearEnergy / (motionEnergy + 1e-9);
        const motionType: MotionType =
          nearRatio > 0.55 ? "hand" :
          motionRatio > 7.0 ? "body" : "unknown";  // ✅ Raised body threshold too

        this.onMotionDetected({ motionIntensity: motionRatio, motionType, timestamp: now });
      }
    }

    this.rafId = requestAnimationFrame(() => this.scanLoop());
  }

  isActive(): boolean    { return this.ctx !== null && !this.isCalibrating; }
  isCalibrated(): boolean { return !this.isCalibrating && this.ctx !== null; }

  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);

    // ✅ Fade out over 150ms before stopping — no click
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, this.ctx.currentTime);
      this.gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.15);
      setTimeout(() => {
        this.osc?.stop();
        this.osc?.disconnect();
        this.gainNode?.disconnect();
        this.micStream?.getTracks().forEach((t) => t.stop());
        this.ctx?.close();
        this.ctx = null;
      }, 200);
    } else {
      this.osc?.stop();
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.ctx?.close();
      this.ctx = null;
    }

    this.rafId = null;
    console.log("AtMoS SpatialRadar: Offline");
  }
}
