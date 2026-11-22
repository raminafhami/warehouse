import sys
from pathlib import Path

import pypdfium2 as pdfium
import zxingcpp


def verify_label(path, expected):
    with pdfium.PdfDocument(path) as document:
        assert len(document) == 1, "Expected exactly one label page"
        page = document[0]
        try:
            text_page = page.get_textpage()
            try:
                text = text_page.get_text_range()
            finally:
                text_page.close()
            assert all(code in text for code in expected), "Missing human-readable code"
            assert not any(
                marker in text
                for marker in ("reval", "PHONE-PRINT-QA", "QA-SHELF", "چاپ بارکد")
            ), "Label includes application controls or detail content"
            bitmap = page.render(scale=300 / 72)
            try:
                barcodes = zxingcpp.read_barcodes(
                    bitmap.to_pil(), formats=zxingcpp.BarcodeFormat.Code128
                )
                assert sorted(barcode.text for barcode in barcodes) == sorted(expected), (
                    "Unexpected barcode set"
                )
            finally:
                bitmap.close()
        finally:
            page.close()
    print(f"PASS: {len(expected)} Code 128 barcode(s) on one page")


if __name__ == "__main__":
    verify_label(Path(sys.argv[1]), sys.argv[2:])
