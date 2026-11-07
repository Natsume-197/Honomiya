import { describe, expect, test } from "bun:test";
import { englishNumber, spanishNumber } from "./numerals";

describe("spoken numbers", () => {
	test("English cardinals and years", () => {
		expect(englishNumber("0")).toBe("zero");
		expect(englishNumber("13")).toBe("thirteen");
		expect(englishNumber("42")).toBe("fortytwo");
		expect(englishNumber("305")).toBe("threehundredfive");
		expect(englishNumber("12000")).toBe("twelvethousand");
		expect(englishNumber("1984")).toBe("nineteeneightyfour");
		expect(englishNumber("1905")).toBe("nineteenohfive");
		expect(englishNumber("1900")).toBe("nineteenhundred");
		expect(englishNumber("2005")).toBe("twothousandfive");
		expect(englishNumber("007")).toBe("zerozeroseven");
	});

	test("Spanish cardinals", () => {
		expect(spanishNumber("1")).toBe("uno");
		expect(spanishNumber("16")).toBe("dieciséis");
		expect(spanishNumber("21")).toBe("veintiuno");
		expect(spanishNumber("31")).toBe("treintayuno");
		expect(spanishNumber("100")).toBe("cien");
		expect(spanishNumber("101")).toBe("cientouno");
		expect(spanishNumber("555")).toBe("quinientoscincuentaycinco");
		expect(spanishNumber("1000")).toBe("mil");
		expect(spanishNumber("1984")).toBe("milnovecientosochentaycuatro");
		expect(spanishNumber("21000")).toBe("veintiúnmil");
		expect(spanishNumber("2000000")).toBe("dosmillones");
		expect(spanishNumber("1000000")).toBe("unmillón");
	});
});
