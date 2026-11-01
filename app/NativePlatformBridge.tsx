"use client";

import { useEffect } from "react";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

function bufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120) || "My Desk document";
}

export default function NativePlatformBridge() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      if (anchor.hasAttribute("download")) {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            const response = await fetch(anchor.href);
            if (!response.ok) throw new Error(`Download failed (${response.status})`);
            const blob = await response.blob();
            const fallbackName = new URL(anchor.href).pathname.split("/").pop() || "My Desk document";
            const fileName = safeFileName(anchor.download || fallbackName);
            const file = await Filesystem.writeFile({
              path: fileName,
              data: bufferToBase64(await blob.arrayBuffer()),
              directory: Directory.Cache,
              recursive: true,
            });
            await Share.share({
              title: fileName,
              files: [file.uri],
              dialogTitle: "Save or share file",
            });
          } catch (error) {
            console.error("Could not prepare this file for sharing.", error);
            window.alert("My Desk could not prepare this file. Please try again.");
          }
        })();
        return;
      }

      if (anchor.target.toLowerCase() === "_blank") {
        const url = new URL(anchor.href, window.location.href);
        if (url.protocol === "http:" || url.protocol === "https:") {
          event.preventDefault();
          event.stopPropagation();
          void Browser.open({ url: url.href });
        }
      }
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  return null;
}
