import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.mydesk.portal",
  appName: "My Desk",
  webDir: "out",
  server: {
    androidScheme: "https",
  },
};

export default config;
