import { describe, expect, it } from "vitest";
import { lastSentence } from "./Home";

describe("the home card's last line", () => {
  it("keeps a line of dialogue as it is, without quote marks of its own", () => {
    expect(lastSentence("风雪封了山道。老汉道：“休怪老汉不讲情面！”")).toBe("老汉道：“休怪老汉不讲情面！”");
    expect(lastSentence("门外，有人轻轻叩了三下。")).toBe("门外，有人轻轻叩了三下。");
  });
  it("drops a closing quote whose opening was cut off, and closes one left open", () => {
    const long = "老汉道：“住一夜可以，明日天亮就走，家里还有老小要养活，柴米油盐样样要钱，你们这些走镖的莫要怪我，休怪老汉不讲情面！”";
    const line = lastSentence(long);
    expect(line.startsWith("…")).toBe(true);
    expect(line.endsWith("情面！")).toBe(true);
    expect(line).not.toContain("”");
    expect(line[1]).not.toBe("，");
    expect(lastSentence("他低声说：“明日再来")).toBe("他低声说：“明日再来”");
  });
});
