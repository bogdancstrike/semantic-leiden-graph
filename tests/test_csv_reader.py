from pathlib import Path

import pytest

from app.errors import ValidationFailed
from app.pipeline.csv_reader import CsvDocument, CsvRowError, count_rows, detect_layout, iter_rows


def write(tmp_path: Path, content: str, name="f.csv", encoding="utf-8") -> Path:
    path = tmp_path / name
    path.write_bytes(content.encode(encoding))
    return path


def test_comma_with_bom_and_metadata(tmp_path):
    path = write(tmp_path, "\ufeffID,Text,Desk\n1,Hello world,news\n2,\"Multi\nline, quoted\",\n")
    layout = detect_layout(path, 20)
    assert layout.delimiter == "," and layout.metadata_columns == {"Desk": "desk"}
    rows = list(iter_rows(path, layout, text_max_chars=100, max_rows=10))
    assert rows[0] == CsvDocument(2, "1", "Hello world", {"desk": "news"})
    assert rows[1].text == "Multi line, quoted" and rows[1].metadata == {}
    assert count_rows(path, layout) == 2


def test_semicolon_excel_export(tmp_path):
    path = write(tmp_path, "id;text\na;Căi ferate noi\n")
    layout = detect_layout(path, 20)
    assert layout.delimiter == ";"
    assert next(iter_rows(path, layout, text_max_chars=100, max_rows=10)).text == "Căi ferate noi"


def test_the_column_to_analyse_must_be_named_when_there_is_no_text_header(tmp_path):
    with pytest.raises(ValidationFailed, match="Choose the column to analyse") as info:
        detect_layout(write(tmp_path, "identifier,body\n1,x\n"), 20)
    assert info.value.details["found"] == ["identifier", "body"]


def test_windows_1252_file_is_detected_and_read(tmp_path):
    path = write(tmp_path, "id,text\n1,café crème – “quoted”\n", encoding="cp1252")
    layout = detect_layout(path, 20)
    assert layout.encoding == "cp1252" and layout.encoding_detected
    assert next(iter_rows(path, layout, text_max_chars=100, max_rows=10)).text == "café crème – “quoted”"


def test_explicit_encoding_is_used_and_checked(tmp_path):
    path = write(tmp_path, "id;text\n1;Căi ferate şi poduri\n", encoding="cp1250")  # legacy cedilla ş
    layout = detect_layout(path, 20, encoding="windows-1250")
    assert layout.encoding == "cp1250" and not layout.encoding_detected
    assert next(iter_rows(path, layout, text_max_chars=100, max_rows=10)).text == "Căi ferate şi poduri"
    with pytest.raises(ValidationFailed, match="Unknown encoding"):
        detect_layout(path, 20, encoding="klingon-8")
    with pytest.raises(ValidationFailed, match="not a text encoding"):
        detect_layout(path, 20, encoding="base64")


def test_row_level_errors_do_not_abort(tmp_path):
    path = write(tmp_path, "id,text\n,no id\n2,\n3," + "x" * 50 + "\n4,ok\n")
    layout = detect_layout(path, 20)
    items = list(iter_rows(path, layout, text_max_chars=10, max_rows=10))
    errors = [i for i in items if isinstance(i, CsvRowError)]
    docs = [i for i in items if isinstance(i, CsvDocument)]
    assert [e.reason.split(" ")[0] for e in errors] == ["Empty", "Empty", "Text"]
    assert [d.external_id for d in docs] == ["4"]


def test_row_limit(tmp_path):
    path = write(tmp_path, "id,text\n1,a\n2,b\n3,c\n")
    items = list(iter_rows(path, detect_layout(path, 20), text_max_chars=10, max_rows=2))
    assert isinstance(items[-1], CsvRowError) and "Row limit" in items[-1].reason


def test_mapped_columns_and_generated_ids(tmp_path):
    path = write(tmp_path, "Key;Body;Desk;Lang\nk1;Hello;news;en\n")
    layout = detect_layout(path, 20, id_column="key", text_column="BODY", metadata_columns=["Lang"])
    assert (layout.id_column, layout.text_column, layout.metadata_columns) == ("Key", "Body", {"Lang": "lang"})
    assert next(iter_rows(path, layout, text_max_chars=100, max_rows=10)) == CsvDocument(2, "k1", "Hello", {"lang": "en"})

    path = write(tmp_path, "body\nsame text\n\n,\nsame  text\n", name="g.csv")
    layout = detect_layout(path, 20, text_column="body", generate_ids=True)
    items = list(iter_rows(path, layout, text_max_chars=100, max_rows=10))
    docs = [i for i in items if isinstance(i, CsvDocument)]
    # whitespace-normalised text hashes to the same id, so re-imports stay idempotent
    assert layout.id_column is None and len({d.external_id for d in docs}) == 1
    assert docs[0].external_id.startswith("sha1:")


def test_cell_longer_than_pythons_default_limit_is_a_row_error_not_a_crash(tmp_path):
    # Python's csv module refuses cells over 131,072 characters by default and raised
    # for the whole file ("field larger than field limit"), failing the import job.
    long_text = "word " * 40_000  # 200,000 characters
    path = write(tmp_path, f'id,text\na,short one\nb,"{long_text}"\nc,after it\n')
    layout = detect_layout(path, 20)
    assert count_rows(path, layout) == 3
    rows = list(iter_rows(path, layout, text_max_chars=20_000, max_rows=10))
    assert [type(r).__name__ for r in rows] == ["CsvDocument", "CsvRowError", "CsvDocument"]
    assert "199,999 characters" in rows[1].reason and "truncate" in rows[1].reason  # trailing space normalised away
    assert rows[2].text == "after it"


def test_truncate_long_texts_imports_the_beginning(tmp_path):
    path = write(tmp_path, 'id,text\nb,"' + "word " * 40_000 + '"\n')
    layout = detect_layout(path, 20)
    (row,) = list(iter_rows(path, layout, text_max_chars=20_000, max_rows=10, truncate_long_texts=True))
    assert isinstance(row, CsvDocument) and row.truncated
    assert len(row.text) <= 20_000 and row.text.endswith("word")  # cut at a word boundary


def test_unparseable_giant_cell_costs_one_row(tmp_path, monkeypatch):
    import app.pipeline.csv_reader as reader

    monkeypatch.setattr(reader, "CELL_LIMIT_CHARS", 100)  # stand-in for 64 million
    path = write(tmp_path, 'id,text\na,fine\nb,"' + "x" * 500 + '"\nc,still read\n')
    layout = detect_layout(path, 20)
    rows = list(iter_rows(path, layout, text_max_chars=10, max_rows=10))
    assert isinstance(rows[1], CsvRowError) and "never closed" in rows[1].reason
    assert rows[2] == CsvDocument(4, "c", "still read", {})
    assert count_rows(path, layout) == 3


def test_detected_utf8_that_is_not_falls_back_before_anything_is_imported(tmp_path):
    body = "id,text\n" + "".join(f"r{i},row number {i}\n" for i in range(30_000))
    path = tmp_path / "late.csv"
    path.write_bytes(body.encode() + "bad,café\n".encode("cp1252"))
    layout = detect_layout(path, 20)  # the sniffed head is plain ASCII
    assert layout.encoding == "utf-8-sig"
    assert count_rows(path, layout) == 30_001  # the counting pass re-reads it as Windows-1252
    assert layout.encoding == "cp1252"
    *_, last = iter_rows(path, layout, text_max_chars=100, max_rows=100_000)
    assert last.text == "café"


def test_explicit_utf8_with_a_bad_byte_fails_clearly(tmp_path):
    body = "id,text\n" + "".join(f"r{i},row number {i}\n" for i in range(30_000))
    path = tmp_path / "late.csv"
    path.write_bytes(body.encode() + b"bad,\xff\xfe not utf8\n")
    layout = detect_layout(path, 20, encoding="utf-8")
    with pytest.raises(ValidationFailed, match="not valid UTF-8 near line"):
        count_rows(path, layout)


def test_any_header_names_with_the_column_to_analyse_chosen(tmp_path):
    path = write(tmp_path, "Title|Abstract|Year|Journal\nRail study|Freight on rails grows|2021|Transport Rev\n")
    layout = detect_layout(path, 20, text_column="abstract")
    assert layout.delimiter == "|" and layout.text_column == "Abstract" and layout.id_column is None
    assert layout.metadata_columns == {"Title": "title", "Year": "year", "Journal": "journal"}
    (doc,) = list(iter_rows(path, layout, text_max_chars=100, max_rows=10))
    assert doc.text == "Freight on rails grows" and doc.external_id.startswith("sha1:")
    assert doc.metadata == {"title": "Rail study", "year": "2021", "journal": "Transport Rev"}


def test_file_without_a_header_row(tmp_path):
    path = write(tmp_path, "7\tfirst document text\tnews\n8\tsecond one\tblog\n", name="plain.tsv")
    layout = detect_layout(path, 20, has_header=False, text_column="column_2", id_column="column_1")
    assert layout.columns == ["column_1", "column_2", "column_3"] and layout.delimiter == "\t"
    docs = list(iter_rows(path, layout, text_max_chars=100, max_rows=10))
    assert [(d.row, d.external_id, d.text, d.metadata) for d in docs] == [
        (1, "7", "first document text", {"column_3": "news"}),
        (2, "8", "second one", {"column_3": "blog"}),
    ]
    assert count_rows(path, layout) == 2


def test_blank_and_repeated_headers_get_unique_names(tmp_path):
    path = write(tmp_path, "name,,Name,text, name \na,b,c,the text,d\n")
    layout = detect_layout(path, 20)
    assert layout.columns == ["name", "column_2", "Name_2", "text", "name_3"]
    (doc,) = list(iter_rows(path, layout, text_max_chars=100, max_rows=10))
    assert doc.text == "the text" and doc.metadata == {"name": "a", "column_2": "b", "name_2": "c", "name_3": "d"}
    assert layout.metadata_dropped == []


def test_excel_sep_line_and_semicolons_inside_quoted_text(tmp_path):
    path = write(tmp_path, 'sep=;\nkey;body\nk1;"one; two, three"\n')
    layout = detect_layout(path, 20, text_column="body", id_column="key")
    assert layout.delimiter == ";" and layout.skip_records == 2
    (doc,) = list(iter_rows(path, layout, text_max_chars=100, max_rows=10))
    assert (doc.row, doc.external_id, doc.text) == (3, "k1", "one; two, three")


def test_delimiter_guess_prefers_the_consistent_split(tmp_path):
    rows = "".join(f'r{i};"a, b, c {i}";x\n' for i in range(20))
    layout = detect_layout(write(tmp_path, "id;text;tag\n" + rows), 20)
    assert layout.delimiter == ";"
    forced = detect_layout(write(tmp_path, "id;text\n1;x\n", name="d.csv"), 20, delimiter="tab", text_column="id;text")
    assert forced.delimiter == "\t" and forced.columns == ["id;text"]
    with pytest.raises(ValidationFailed, match="one character"):
        detect_layout(write(tmp_path, "id,text\n1,x\n", name="e.csv"), 20, delimiter='"')


def test_utf16_with_bom_as_excel_unicode_text_writes_it(tmp_path):
    path = tmp_path / "unicode.txt"
    path.write_bytes("id\ttext\n1\tȘtiri în română\n".encode("utf-16"))
    layout = detect_layout(path, 20)
    assert layout.encoding == "utf-16" and layout.delimiter == "\t"
    assert next(iter_rows(path, layout, text_max_chars=100, max_rows=10)).text == "Știri în română"


@pytest.mark.parametrize(
    "content, kind",
    [(b"PK\x03\x04rest-of-zip", "Excel workbook"), (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1xx", "legacy Excel"), (b"%PDF-1.7", "PDF")],
)
def test_binary_files_are_refused_by_name(tmp_path, content, kind):
    path = tmp_path / "data.csv"
    path.write_bytes(content)
    with pytest.raises(ValidationFailed, match=kind):
        detect_layout(path, 20)


def test_too_many_metadata_columns_is_refused(tmp_path):
    header = ",".join(["text"] + [f"m{i}" for i in range(5)])
    path = write(tmp_path, header + "\nx,1,2,3,4,5\n")
    with pytest.raises(ValidationFailed, match="At most 3 metadata columns"):
        detect_layout(path, 3, metadata_columns=["m0", "m1", "m2", "m3"])
    assert detect_layout(path, 3).metadata_dropped == ["m3", "m4"]  # defaults keep the first three


def test_id_list_packs_uuids_and_slices():
    import uuid

    from app.pipeline.ingest import IdList

    ids = [str(uuid.uuid4()) for _ in range(5)]
    packed = IdList(ids[:2])
    packed.extend(ids[2:])
    assert len(packed) == 5 and bool(packed) and not IdList()
    assert packed[1:4] == ids[1:4] and list(packed) == ids and packed[0:5:2] == ids[0:5:2]
