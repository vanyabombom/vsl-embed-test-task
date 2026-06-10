"use client";
import { useEffect, useState } from "react";

function isRestrictedIOSWebView(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  if (!isIOS) return false;
  const hasSafari = /Safari\//.test(ua);
  if (hasSafari) return false;
  const knownWorking = /Instagram|FBAN|FB_IAB|FBAV|Line\/|Twitter|Snapchat/i.test(ua);
  if (knownWorking) return false;
  return true;
}

export default function UATestPage() {
  const [ua, setUA] = useState("");
  const [restricted, setRestricted] = useState(false);

  useEffect(() => {
    setUA(navigator.userAgent || "");
    setRestricted(isRestrictedIOSWebView());
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
      <h2>WebView Debug v2</h2>
      <p style={{ color: restricted ? "lime" : "red", fontWeight: "bold", fontSize: 18 }}>
        Restricted WebView: {restricted ? "YES ✅" : "NO ❌"}
      </p>
      <p style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
        iOS: {/iPhone|iPad|iPod/.test(ua) ? "✅" : "❌"} |
        Safari/: {/Safari\//.test(ua) ? "✅" : "❌"} |
        Known app: {/Instagram|FBAN|FB_IAB|FBAV|Line\/|Twitter|Snapchat/i.test(ua) ? "✅" : "❌"}
      </p>
      <hr />
      <p>{ua}</p>
    </div>
  );
}
