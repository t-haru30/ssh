/** Bound browser callbacks as well as the native timeout; never log coordinates. */
export function currentLocation(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("このブラウザでは現在地を取得できません。駅名から選んでください。")); return; }
    let finished = false;
    const fail = (code?: number) => {
      if (finished) return;
      finished = true; window.clearTimeout(timer);
      reject(new Error(code === 1 ? "位置情報が許可されていません。ブラウザ・端末の位置情報設定で許可するか、駅名から選んでください。"
        : code === 3 ? "現在地の取得がタイムアウトしました。通信・位置情報設定を確認するか、駅名から選んでください。"
        : "現在地を取得できませんでした。端末の位置情報を有効にするか、駅名から選んでください。"));
    };
    const timer = window.setTimeout(() => fail(3), 16000);
    try {
      navigator.geolocation.getCurrentPosition(position => {
        if (finished) return;
        const { latitude, longitude } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) { fail(); return; }
        finished = true; window.clearTimeout(timer); resolve({ latitude, longitude });
      }, error => fail(error.code), { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
    } catch { fail(); }
  });
}
