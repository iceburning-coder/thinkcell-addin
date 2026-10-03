import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CANONICAL_ADDIN_ID = "8dd87d2b-8555-4f61-96bf-2fce56da2b1c"


class ManifestIdentityTest(unittest.TestCase):
    def test_manifest_keeps_the_document_settings_identity(self):
        root = ET.parse(ROOT / "manifest.xml").getroot()
        namespace = {"office": "http://schemas.microsoft.com/office/appforoffice/1.1"}

        self.assertEqual(root.findtext("office:Id", namespaces=namespace), CANONICAL_ADDIN_ID)


if __name__ == "__main__":
    unittest.main()
