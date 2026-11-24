import { describe, expect, it } from "vitest";
import { parseExif } from "refr/server/services/exif";
import { parseValueKeyword } from "refr/lib/keywords";

/** Hand-built little/big-endian TIFF: IFD0 {Make, Model, ExifIFD →} {DateTimeOriginal}. */
function tiff(le: boolean, make: string, model: string, date: string): Buffer {
  const ascii = (s: string) => Buffer.from(s + "\0", "latin1");
  const mk = ascii(make), md = ascii(model), dt = ascii(date);
  const ifd0 = 8, ifd0Size = 2 + 3 * 12 + 4;
  const exifIfd = ifd0 + ifd0Size, exifSize = 2 + 12 + 4;
  let data = exifIfd + exifSize;
  const buf = Buffer.alloc(data + mk.length + md.length + dt.length);
  const w16 = (o: number, v: number) => (le ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o));
  const w32 = (o: number, v: number) => (le ? buf.writeUInt32LE(v, o) : buf.writeUInt32BE(v, o));
  buf.write(le ? "II" : "MM", 0, "latin1");
  w16(2, 42);
  w32(4, ifd0);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    w16(at, tag); w16(at + 2, type); w32(at + 4, count); w32(at + 8, value);
  };
  const put = (b: Buffer) => { const off = data; b.copy(buf, off); data += b.length; return off; };
  w16(ifd0, 3);
  entry(ifd0 + 2, 0x010f, 2, mk.length, put(mk));
  entry(ifd0 + 14, 0x0110, 2, md.length, put(md));
  entry(ifd0 + 26, 0x8769, 4, 1, exifIfd);
  w16(exifIfd, 1);
  entry(exifIfd + 2, 0x9003, 2, dt.length, put(dt));
  return buf;
}

describe("parseExif", () => {
  it("reads date taken and camera in both byte orders, with the Exif header", () => {
    for (const le of [true, false]) {
      const raw = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff(le, "FUJIFILM", "X-T4", "2024:03:15 14:05:09")]);
      const info = parseExif(raw);
      expect(info.camera).toBe("FUJIFILM X-T4");
      expect(info.takenAt).toEqual(new Date(2024, 2, 15, 14, 5, 9));
    }
  });
  it("doesn't repeat the maker and survives garbage", () => {
    expect(parseExif(tiff(true, "Canon", "Canon EOS R5", "2020:01:01 00:00:00")).camera).toBe("Canon EOS R5");
    expect(parseExif(Buffer.from("not exif at all, definitely"))).toEqual({});
    expect(parseExif(undefined)).toEqual({});
  });
});

describe("metadata keywords", () => {
  it("parses taken: and source:", () => {
    expect(parseValueKeyword("taken:2024-03")).toEqual({ kind: "taken", from: new Date(2024, 2, 1), to: new Date(2024, 3, 1) });
    expect(parseValueKeyword("date:2024")).toMatchObject({ kind: "date" });
    expect(parseValueKeyword("source:artstation")).toEqual({ kind: "source", text: "artstation" });
  });
});
