/**
 * Minimal EXIF reader for the raw `exif` buffer sharp returns: just
 * DateTimeOriginal (falling back to DateTimeDigitized) and Make + Model.
 * Dependency-free on purpose (SPEC §14). Never throws; malformed data → {}.
 */

export type ExifInfo = { takenAt?: Date; camera?: string };

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_ORIGINAL = 0x9003;
const TAG_DATE_DIGITIZED = 0x9004;

export function parseExif(buf: Buffer | undefined): ExifInfo {
  if (!buf || buf.length < 14) return {};
  try {
    // sharp's buffer starts with the APP1 "Exif\0\0" marker; plain TIFF is accepted too
    const tiff = buf.subarray(0, 6).toString("latin1") === "Exif\0\0" ? 6 : 0;
    const order = buf.subarray(tiff, tiff + 2).toString("latin1");
    if (order !== "II" && order !== "MM") return {};
    const le = order === "II";
    const u16 = (o: number) => (le ? buf.readUInt16LE(tiff + o) : buf.readUInt16BE(tiff + o));
    const u32 = (o: number) => (le ? buf.readUInt32LE(tiff + o) : buf.readUInt32BE(tiff + o));
    if (u16(2) !== 42) return {};

    /** IFD entries as tag → {type, count, valueOffset (relative to TIFF start)} */
    const readIfd = (offset: number) => {
      const out = new Map<number, { type: number; count: number; at: number }>();
      if (offset <= 0 || tiff + offset + 2 > buf.length) return out;
      const n = u16(offset);
      for (let i = 0; i < n; i++) {
        const e = offset + 2 + i * 12;
        if (tiff + e + 12 > buf.length) break;
        const type = u16(e + 2);
        const count = u32(e + 4);
        // values ≤ 4 bytes sit inline; ASCII (type 2) bytes = count
        const size = type === 2 ? count : type === 4 ? 4 * count : 0;
        out.set(u16(e), { type, count, at: size > 4 ? u32(e + 8) : e + 8 });
      }
      return out;
    };
    const ascii = (entry: { type: number; count: number; at: number } | undefined) => {
      if (entry?.type !== 2 || tiff + entry.at + entry.count > buf.length) return undefined;
      const s = buf.subarray(tiff + entry.at, tiff + entry.at + entry.count).toString("latin1").replace(/\0.*$/s, "").trim();
      return s || undefined;
    };

    const ifd0 = readIfd(u32(4));
    const info: ExifInfo = {};
    const make = ascii(ifd0.get(TAG_MAKE));
    const model = ascii(ifd0.get(TAG_MODEL));
    // many models already start with the maker ("Canon EOS R5")
    const camera = make && model && !model.toLowerCase().startsWith(make.toLowerCase().split(" ")[0]!) ? `${make} ${model}` : (model ?? make);
    if (camera) info.camera = camera;

    const exifPtr = ifd0.get(TAG_EXIF_IFD);
    if (exifPtr?.type === 4) {
      const exif = readIfd(u32(exifPtr.at));
      const raw = ascii(exif.get(TAG_DATE_ORIGINAL)) ?? ascii(exif.get(TAG_DATE_DIGITIZED));
      const m = raw && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
      if (m) {
        // EXIF dates are local wall-clock time without a zone
        const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
        if (!Number.isNaN(d.getTime()) && +m[1]! >= 1900) info.takenAt = d;
      }
    }
    return info;
  } catch {
    return {};
  }
}
