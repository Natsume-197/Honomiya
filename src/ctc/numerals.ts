/**
 * Spoken forms of digit runs, for aligning text against narration. Each
 * function returns words without spaces between them: the aligner drops
 * spaces anyway, and the result is a run of letters the model can emit.
 */

const ENGLISH_SMALL = [
	"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
	"ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
	"seventeen", "eighteen", "nineteen",
];
const ENGLISH_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ENGLISH_SCALES = ["", "thousand", "million", "billion"];

function englishBelowThousand(value: number): string[] {
	const words: string[] = [];
	const hundreds = Math.floor(value / 100);
	const rest = value % 100;
	if (hundreds > 0) words.push(ENGLISH_SMALL[hundreds] as string, "hundred");
	if (rest >= 20) {
		words.push(ENGLISH_TENS[Math.floor(rest / 10)] as string);
		if (rest % 10 > 0) words.push(ENGLISH_SMALL[rest % 10] as string);
	} else if (rest > 0 || hundreds === 0) {
		words.push(ENGLISH_SMALL[rest] as string);
	}
	return words;
}

/** 1984 → nineteen eighty-four; 1905 → nineteen oh five; 2015 → twenty fifteen. */
function englishYear(value: number): string[] | undefined {
	if (value < 1100 || value > 2099 || (value >= 2000 && value < 2010)) return undefined;
	const high = Math.floor(value / 100);
	const low = value % 100;
	if (low === 0) return [...englishBelowThousand(high), "hundred"];
	return [...englishBelowThousand(high), ...(low < 10 ? ["oh"] : []), ...englishBelowThousand(low)];
}

export function englishNumber(digits: string): string {
	const value = Number(digits);
	if (!Number.isSafeInteger(value) || digits.length > 12 || (digits.length > 1 && digits.startsWith("0"))) {
		return Array.from(digits, (digit) => ENGLISH_SMALL[Number(digit)]).join("");
	}
	if (digits.length === 4) {
		const year = englishYear(value);
		if (year) return year.join("");
	}
	if (value === 0) return "zero";
	const words: string[] = [];
	let remaining = value;
	for (let scale = 0; remaining > 0; scale += 1) {
		const group = remaining % 1000;
		if (group > 0) {
			words.unshift(...englishBelowThousand(group), ...(scale > 0 ? [ENGLISH_SCALES[scale] as string] : []));
		}
		remaining = Math.floor(remaining / 1000);
	}
	return words.join("");
}

const SPANISH_SMALL = [
	"cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
	"diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete",
	"dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés",
	"veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve",
];
const SPANISH_TENS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const SPANISH_HUNDREDS = [
	"", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos",
	"seiscientos", "setecientos", "ochocientos", "novecientos",
];

function spanishBelowThousand(value: number, apocope: boolean): string[] {
	if (value === 100) return ["cien"];
	const words: string[] = [];
	const hundreds = Math.floor(value / 100);
	const rest = value % 100;
	if (hundreds > 0) words.push(SPANISH_HUNDREDS[hundreds] as string);
	if (rest >= 30) {
		words.push(SPANISH_TENS[Math.floor(rest / 10)] as string);
		if (rest % 10 > 0) words.push("y", rest % 10 === 1 && apocope ? "un" : (SPANISH_SMALL[rest % 10] as string));
	} else if (rest > 0) {
		words.push(rest === 1 && apocope ? "un" : rest === 21 && apocope ? "veintiún" : (SPANISH_SMALL[rest] as string));
	}
	return words;
}

export function spanishNumber(digits: string): string {
	const value = Number(digits);
	if (!Number.isSafeInteger(value) || digits.length > 12 || (digits.length > 1 && digits.startsWith("0"))) {
		return Array.from(digits, (digit) => SPANISH_SMALL[Number(digit)]).join("");
	}
	if (value === 0) return "cero";
	const millions = Math.floor(value / 1_000_000);
	const thousands = Math.floor((value % 1_000_000) / 1000);
	const units = value % 1000;
	const words: string[] = [];
	if (millions > 0) {
		words.push(...(millions === 1 ? ["un", "millón"] : [...spanishBelowThousand(millions, true), "millones"]));
	}
	if (thousands > 0) {
		words.push(...(thousands === 1 ? [] : spanishBelowThousand(thousands, true)), "mil");
	}
	if (units > 0) words.push(...spanishBelowThousand(units, false));
	return words.join("");
}
