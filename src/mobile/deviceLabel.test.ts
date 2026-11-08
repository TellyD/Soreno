import { expect, it } from "vitest";
import { deviceLabel } from "./deviceLabel";

it("names the phone by its system and browser", () => {
  const cases: [string, number, string][] = [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      5,
      "iPhone · Safari",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
      5,
      "iPhone · Chrome",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      5,
      "iPad · Safari",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
      5,
      "Android · Chrome",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36",
      5,
      "Android · Samsung Internet",
    ],
    [
      "Mozilla/5.0 (Android 15; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
      5,
      "Android · Firefox",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
      0,
      "Windows · Edge",
    ],
    ["curl/8.0", 0, "Navigateur"],
  ];
  expect(cases.map(([agent, touch]) => deviceLabel(agent, touch))).toEqual(
    cases.map(([, , label]) => label),
  );
});
