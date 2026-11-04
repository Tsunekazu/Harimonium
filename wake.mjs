export class ScreenAwake {
  constructor(navigator, document, report) {
    this.navigator = navigator; this.document = document; this.report = report;
    this.wanted = false; this.lock = null; this.pending = false;
  }
  setWanted(wanted) {
    const changed = this.wanted !== Boolean(wanted); this.wanted = Boolean(wanted);
    if (changed) this.refresh();
  }
  async refresh() {
    if (!this.wanted || this.document.hidden) {
      const lock = this.lock; this.lock = null;
      if (lock) await lock.release().catch(() => {});
      if (this.lock || (this.wanted && !this.document.hidden)) return;
      this.report(this.wanted ? 'Keep HARI open during practice.' : 'The screen will stay awake during practice when supported.');
      return;
    }
    if (this.lock || this.pending) return;
    if (!this.navigator.wakeLock) { this.report('This browser cannot keep the screen awake automatically.'); return; }
    this.pending = true;
    let retryAfterRelease = false;
    try {
      const lock = await this.navigator.wakeLock.request('screen');
      if (!this.wanted || this.document.hidden) {
        await lock.release();
        // Visibility may have returned while this stale sentinel was releasing.
        // Its visible refresh saw pending=true, so complete that missed request.
        retryAfterRelease = this.wanted && !this.document.hidden;
        return;
      }
      this.lock = lock; this.report('Screen awake');
      lock.addEventListener('release', () => {
        if (this.lock !== lock) return;
        this.lock = null;
        this.report(this.wanted ? 'The phone released screen-awake mode.' : 'Screen awake is off.');
      });
    } catch { this.report('The phone declined screen-awake mode. Keep HARI visible.'); }
    finally {
      this.pending = false;
      if (retryAfterRelease) this.refresh();
    }
  }
}
