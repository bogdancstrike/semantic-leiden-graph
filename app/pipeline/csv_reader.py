"""Streaming reader for any delimited text file (CSV, TSV, semicolon, pipe ...).

The caller names the column to analyse (``text_column``); everything else is optional:

* **ids** come from an id column, or -- by default when the file has no ``id`` header --
  from the text itself (a content hash), so re-importing the same file stays idempotent
* **metadata**: any other columns (stored in ES, filterable, never embedded); by default
  every other column, up to ``metadata_max_keys``
* **encoding**: a BOM wins (UTF-8, UTF-16, UTF-32); else UTF-8 when the head decodes as
  UTF-8, else Windows-1252 -- or whatever codec the caller names. An auto-detected UTF-8
  file that turns out not to be UTF-8 further down is re-read as Windows-1252 while rows
  are being counted, before anything is written
* **delimiter**: an Excel ``sep=;`` first line, the caller's choice, or the candidate among
  ``, ; TAB |`` that splits the first records into the most consistent number of cells
* **header row** optional: without one the columns are ``column_1`` ... ``column_n``
* header names are made unique (blank -> ``column_N``, repeats -> ``name_2``) with the
  same rule as the browser preview (``frontend/src/lib/csv.ts``), so a mapping chosen
  there resolves here
* binary files (Excel workbooks, archives, PDFs) are refused with a message naming them
* rows are validated individually; a bad row is reported, not fatal -- including a cell
  too large to parse, which Python's csv module otherwise raises for the whole file
* streaming throughout: a 1 GB file is read twice (count, then import) in constant memory
"""

from __future__ import annotations

import codecs
import csv
import io
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Iterator

from app.errors import ValidationFailed
from app.ids import content_id, normalize_external_id, normalize_metadata_key, normalize_text

DELIMITERS = ",;\t|"
DELIMITER_NAMES = {"comma": ",", "semicolon": ";", "tab": "\t", "pipe": "|", "\\t": "\t"}
SNIFF_BYTES = 256 * 1024
SNIFF_RECORDS = 50
AUTO_FALLBACK_ENCODING = "cp1252"  # what Excel's plain "CSV" means on Western Windows
_SEP_LINE = re.compile(r"^﻿?sep=(.)\s*$", re.IGNORECASE)

# Python's csv module refuses cells over 131,072 characters by default and raises for the
# whole file. Legitimately long texts must parse (they are then skipped or truncated by
# the TEXT_MAX_CHARS check, row by row), so the cap is raised -- but kept finite: a quote
# opened and never closed turns the rest of the file into one cell, and that must stay a
# bounded, reportable row error rather than a gigabyte string.
CELL_LIMIT_CHARS = 64 * 1024 * 1024

_BOMS = (  # UTF-32 first: its little-endian BOM starts with UTF-16's
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)
_BINARY = (
    (b"PK\x03\x04", "an Excel workbook or a ZIP archive (.xlsx, .zip)"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "a legacy Excel or Office file (.xls)"),
    (b"\x1f\x8b", "a gzip archive"),
    (b"%PDF", "a PDF document"),
    (b"\x89PNG", "a PNG image"),
    (b"\xff\xd8\xff", "a JPEG image"),
    (b"SQLite format 3", "a SQLite database"),
)


def _allow_long_cells(text_max_chars: int = 0) -> int:
    limit = max(CELL_LIMIT_CHARS, text_max_chars * 4)
    csv.field_size_limit(limit)
    return limit


@dataclass
class CsvDocument:
    row: int
    external_id: str
    text: str
    metadata: dict[str, str] = field(default_factory=dict)
    truncated: bool = False


@dataclass
class CsvRowError:
    row: int
    external_id: str | None
    reason: str


@dataclass
class CsvLayout:
    delimiter: str
    columns: list[str]  # unique names, in file order
    id_column: str | None  # None: ids are derived from the text (content hash)
    text_column: str
    metadata_columns: dict[str, str]  # column name -> normalised metadata key
    encoding: str = "utf-8-sig"
    encoding_errors: str = "strict"
    encoding_detected: bool = True  # auto-detected, so a late non-UTF-8 byte may fall back
    has_header: bool = True
    skip_records: int = 1  # the sep= line and the header row, before the first data row
    metadata_dropped: list[str] = field(default_factory=list)

    def index(self, column: str) -> int:
        return self.columns.index(column)

    def describe(self) -> dict:
        return {
            "encoding": encoding_label(self.encoding),
            "delimiter": self.delimiter,
            "has_header": self.has_header,
            "columns": self.columns[:200],
        }


# ---------------------------------------------------------------------------- format


# Python codec names as the web labels the UI offers (and sends back).
_LABELS = {
    "utf-8-sig": "utf-8",
    "utf-16-le": "utf-16le",
    "utf-16-be": "utf-16be",
    "cp1252": "windows-1252",
    "cp1250": "windows-1250",
    "iso8859-1": "iso-8859-1",
    "latin-1": "iso-8859-1",
    "iso8859-2": "iso-8859-2",
}


def encoding_label(codec: str) -> str:
    return _LABELS.get(codec, codec)



def unique_headers(raw: list[str]) -> list[str]:
    """Header cells as usable, unique column names (mirrors ``uniqueHeaders`` in the UI)."""
    names: list[str] = []
    seen: set[str] = set()
    for position, cell in enumerate(raw, 1):
        base = " ".join(cell.replace("﻿", "").split()) or f"column_{position}"
        name, n = base, 2
        while name.lower() in seen:
            name, n = f"{base}_{n}", n + 1
        seen.add(name.lower())
        names.append(name)
    return names


def _refuse_binary(head: bytes) -> None:
    for signature, kind in _BINARY:
        if head.startswith(signature):
            raise ValidationFailed(
                f"This file is {kind}, not delimited text. Save or export it as CSV and upload that instead."
            )


def detect_encoding(head: bytes) -> str:
    """The codec to read a file with, from its first bytes."""
    for bom, encoding in _BOMS:
        if head.startswith(bom):
            return encoding
    if b"\x00" in head[:4096]:
        sample = head[:4096]
        half = max(len(sample) // 2, 1)
        even, odd = sample[0::2].count(0), sample[1::2].count(0)
        if odd > half * 0.3 and even < half * 0.05:
            return "utf-16-le"
        if even > half * 0.3 and odd < half * 0.05:
            return "utf-16-be"
        raise ValidationFailed("This file contains binary data (NUL bytes), not delimited text.")
    try:
        codecs.getincrementaldecoder("utf-8")().decode(head, final=False)
        return "utf-8-sig"
    except UnicodeDecodeError:
        return AUTO_FALLBACK_ENCODING


def _resolve_encoding(requested: str | None, head: bytes) -> tuple[str, bool]:
    """(codec, auto-detected?) for an optional caller-named encoding."""
    if requested is None or requested.strip().lower() in ("", "auto"):
        return detect_encoding(head), True
    try:
        info = codecs.lookup(requested.strip())
    except LookupError as exc:
        raise ValidationFailed(f"Unknown encoding {requested!r}.") from exc
    if not getattr(info, "_is_text_encoding", True):
        raise ValidationFailed(f"{requested!r} is not a text encoding.")
    # utf-8 files from Excel carry a BOM; utf-8-sig reads both kinds.
    return ("utf-8-sig" if info.name == "utf-8" else info.name), False


def _resolve_delimiter(requested: str | None) -> str | None:
    if requested is None or requested == "" or requested.strip().lower() == "auto":
        return None
    delimiter = DELIMITER_NAMES.get(requested.strip().lower(), requested)
    if len(delimiter) != 1 or delimiter in "\"\r\n":
        raise ValidationFailed(
            "The delimiter must be one character (not a quote or a line break), "
            "or one of comma, semicolon, tab, pipe."
        )
    return delimiter


def _sniff_records(text: str, delimiter: str) -> list[list[str]]:
    """The first non-blank records of the head; an unparseable record is skipped, as in iter_rows."""
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    records: list[list[str]] = []
    for _ in range(SNIFF_RECORDS * 2):
        try:
            record = next(reader)
        except StopIteration:
            break
        except csv.Error:
            continue
        if any(cell.strip() for cell in record):
            records.append(record)
            if len(records) == SNIFF_RECORDS:
                break
    return records


def guess_delimiter(text: str) -> str:
    """The candidate that splits the first records into the most consistent cell count."""
    best, best_score = ",", (0, 0)
    for candidate in DELIMITERS:
        records = _sniff_records(text, candidate)
        if not records:
            continue
        width, frequency = Counter(len(r) for r in records).most_common(1)[0]
        score = (frequency, width) if width > 1 else (0, 0)
        if score > best_score:
            best, best_score = candidate, score
    return best


def _open(path: Path, layout: CsvLayout):
    return open(path, encoding=layout.encoding, errors=layout.encoding_errors, newline="")


def _not_decodable(layout: CsvLayout, exc: UnicodeDecodeError, line: int) -> ValidationFailed:
    name = layout.encoding.replace("-sig", "").upper()
    return ValidationFailed(
        f"The file is not valid {name} near line {line} ({exc.reason}). "
        "Choose its encoding (for example Windows-1252 or Windows-1250) and import again; nothing was imported."
    )


def _find_column(columns: list[str], wanted: str, role: str) -> str:
    """The column a caller named: exact first, then case- and whitespace-insensitive."""
    if wanted in columns:
        return wanted
    folded = {" ".join(c.split()).lower(): c for c in columns}
    match = folded.get(" ".join(wanted.split()).lower())
    if match is None:
        raise ValidationFailed(
            f"The {role} column {wanted!r} is not in the file. Found: {', '.join(columns) or 'nothing'}.",
            details={"found": columns, "column": wanted},
        )
    return match


def detect_layout(
    path: Path,
    metadata_max_keys: int,
    *,
    id_column: str | None = None,
    text_column: str | None = None,
    metadata_columns: list[str] | None = None,
    generate_ids: bool = False,
    delimiter: str | None = None,
    encoding: str | None = None,
    has_header: bool = True,
) -> CsvLayout:
    """Read the head of the file and resolve how to parse it and what each column is.

    Fails fast (422) on anything that would fail every row: a binary file, an unknown
    codec, a mapping naming a column the file does not have.
    """
    with open(path, "rb") as handle:
        head = handle.read(SNIFF_BYTES)
    if not head.strip():
        raise ValidationFailed("File is empty.")
    _refuse_binary(head)
    codec, detected = _resolve_encoding(encoding, head)
    errors = "replace" if detected and codec == AUTO_FALLBACK_ENCODING else "strict"
    try:
        text = codecs.getincrementaldecoder(codec)(errors=errors).decode(head, final=False)
    except UnicodeDecodeError as exc:
        raise ValidationFailed(
            f"The start of the file is not valid {codec.replace('-sig', '').upper()} ({exc.reason}). "
            "Choose another encoding."
        ) from exc
    if len(head) == SNIFF_BYTES and "\n" in text:
        text = text[: text.rfind("\n") + 1]  # never sniff a record cut in half
    if not text.strip():
        raise ValidationFailed("File is empty.")
    _allow_long_cells()

    skip = 0
    first_line = text.split("\n", 1)[0].rstrip("\r")
    sep_line = _SEP_LINE.match(first_line)
    if sep_line:  # Excel's "sep=;" hint line
        skip = 1
        text = text.split("\n", 1)[1] if "\n" in text else ""
    chosen = _resolve_delimiter(delimiter) or (sep_line.group(1) if sep_line else None) or guess_delimiter(text)

    records = _sniff_records(text, chosen)
    if not records:
        raise ValidationFailed("File has no rows.")
    if has_header:
        columns = unique_headers(records[0])
        skip += 1
    else:
        columns = unique_headers([""] * max(len(r) for r in records))

    if generate_ids and id_column:
        raise ValidationFailed("Choose either an id column or generate_ids, not both.")
    folded = {c.lower(): c for c in columns}
    if text_column:
        text_col = _find_column(columns, text_column, "text")
    elif "text" in folded:
        text_col = folded["text"]
    else:
        raise ValidationFailed(
            f"Choose the column to analyse (text_column). Found: {', '.join(columns)}.",
            details={"found": columns},
        )
    # No id column named and none called "id": ids come from the text, which keeps
    # re-imports of the same file idempotent.
    if generate_ids:
        id_col = None
    elif id_column:
        id_col = _find_column(columns, id_column, "id")
    else:
        id_col = folded.get("id") if folded.get("id") != text_col else None
    if id_col is not None and id_col == text_col:
        raise ValidationFailed("The id column and the column to analyse must be different columns.")

    reserved = {text_col, id_col}
    if metadata_columns is None:
        candidates = [c for c in columns if c not in reserved]
    else:
        if len(metadata_columns) > metadata_max_keys:
            raise ValidationFailed(
                f"At most {metadata_max_keys} metadata columns can be kept; {len(metadata_columns)} were chosen."
            )
        candidates = []
        for wanted in metadata_columns:
            column = _find_column(columns, wanted, "metadata")
            if column in reserved:
                raise ValidationFailed(f"{column!r} is already the id or analysed column; it cannot also be metadata.")
            candidates.append(column)
    kept: dict[str, str] = {}
    dropped: list[str] = []
    for column in candidates:
        key = normalize_metadata_key(column)
        if key and key not in kept.values() and len(kept) < metadata_max_keys:
            kept[column] = key
        else:
            dropped.append(column)
    return CsvLayout(
        delimiter=chosen,
        columns=columns,
        id_column=id_col,
        text_column=text_col,
        metadata_columns=kept,
        encoding=codec,
        encoding_errors=errors,
        encoding_detected=detected,
        has_header=has_header,
        skip_records=skip,
        metadata_dropped=dropped,
    )


# ---------------------------------------------------------------------------- rows


def _records(handle, layout: CsvLayout):
    """A reader positioned at the first data row, and how many records it passed.

    The sep= line and the header are the first *non-blank* records, as in detect_layout.
    """
    reader = csv.reader(handle, delimiter=layout.delimiter)
    consumed = skipped = 0
    while skipped < layout.skip_records:
        try:
            record = next(reader)
        except StopIteration:
            break
        except csv.Error:
            record = ["?"]
        consumed += 1
        if any(cell.strip() for cell in record):
            skipped += 1
    return reader, consumed


def count_rows(path: Path, layout: CsvLayout) -> int:
    """Non-empty records after the header. Unparseable records count too: they become row errors.

    This full pass is also where an auto-detected UTF-8 file proves to be something else:
    the layout then switches to Windows-1252 and counting starts over -- nothing has been
    written yet.
    """
    _allow_long_cells()
    while True:
        count = 0
        reader = None
        try:
            with _open(path, layout) as handle:
                reader, _ = _records(handle, layout)
                while True:
                    try:
                        row = next(reader)
                    except StopIteration:
                        return count
                    except csv.Error:
                        count += 1
                        continue
                    if any(cell.strip() for cell in row):
                        count += 1
        except UnicodeDecodeError as exc:
            if layout.encoding_detected and layout.encoding == "utf-8-sig":
                layout.encoding, layout.encoding_errors = AUTO_FALLBACK_ENCODING, "replace"
                continue
            raise _not_decodable(layout, exc, (reader.line_num if reader else 0) + 1) from exc


def _truncate(text: str, limit: int) -> str:
    """Cut at the last word boundary before ``limit`` (within 200 characters), else hard."""
    cut = text[:limit]
    space = cut.rfind(" ", max(0, limit - 200))
    return (cut[:space] if space > 0 else cut).rstrip()


def iter_rows(
    path: Path,
    layout: CsvLayout,
    *,
    text_max_chars: int,
    max_rows: int,
    truncate_long_texts: bool = False,
) -> Iterator[CsvDocument | CsvRowError]:
    cell_limit = _allow_long_cells(text_max_chars)
    width = len(layout.columns)
    text_at = layout.index(layout.text_column)
    id_at = layout.index(layout.id_column) if layout.id_column is not None else None
    metadata_at = [(layout.index(column), key) for column, key in layout.metadata_columns.items()]

    def cell(row: list[str], at: int) -> str:
        return row[at] if at < len(row) else ""

    with _open(path, layout) as handle:
        reader, row_number = _records(handle, layout)  # records are numbered from 1, the header included
        emitted = 0
        try:
            while True:
                try:
                    row = next(reader)
                except StopIteration:
                    return
                except csv.Error as exc:
                    # The reader resumes at the next record, so one bad cell costs one row.
                    row_number += 1
                    emitted += 1
                    reason = (
                        f"A cell is longer than {cell_limit // 1_000_000} million characters; usually a quote "
                        "that was opened and never closed."
                        if "field larger than field limit" in str(exc)
                        else f"Unreadable CSV row: {exc}."
                    )
                    yield CsvRowError(row_number, None, reason)
                    continue
                row_number += 1
                if not any(value.strip() for value in row):
                    continue
                emitted += 1
                if emitted > max_rows:
                    yield CsvRowError(row_number, None, f"Row limit of {max_rows:,} exceeded; remaining rows ignored.")
                    return
                text = normalize_text(cell(row, text_at))
                truncated = False
                if text and len(text) > text_max_chars and truncate_long_texts:
                    text, truncated = _truncate(text, text_max_chars), True
                if id_at is None:
                    external_id = content_id(text) if text else ""
                    if not text:
                        yield CsvRowError(row_number, None, "Empty text.")
                        continue
                else:
                    external_id = normalize_external_id(cell(row, id_at))
                if len(row) > width:
                    yield CsvRowError(
                        row_number,
                        external_id or None,
                        f"Row has {len(row)} cells but the file has {width} columns; "
                        "usually a separator inside an unquoted value.",
                    )
                    continue
                if not external_id:
                    yield CsvRowError(row_number, None, "Empty id.")
                    continue
                if len(external_id) > 256:
                    yield CsvRowError(row_number, external_id[:40], "id longer than 256 characters.")
                    continue
                if not text:
                    yield CsvRowError(row_number, external_id, "Empty text.")
                    continue
                if len(text) > text_max_chars:
                    yield CsvRowError(
                        row_number,
                        external_id,
                        f"Text has {len(text):,} characters (limit {text_max_chars:,}). "
                        "Enable 'truncate long texts' to import the beginning instead.",
                    )
                    continue
                metadata = {key: value for at, key in metadata_at if (value := cell(row, at).strip())}
                yield CsvDocument(row_number, external_id, text, metadata, truncated)
        except UnicodeDecodeError as exc:
            raise _not_decodable(layout, exc, reader.line_num + 1) from exc
