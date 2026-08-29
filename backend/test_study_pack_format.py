#!/usr/bin/env python3
import unittest

from study_pack import fallback_mcqs, is_timestamp_question


class StudyPackFormatTests(unittest.TestCase):
    def test_rejects_timestamp_quiz_wording(self):
        self.assertTrue(is_timestamp_question("What was discussed around 00:07:41?"))
        self.assertTrue(is_timestamp_question("What was said at 12:03?"))
        self.assertFalse(is_timestamp_question(r"What is the formula for the sample size \( n \)?"))

    def test_fallback_mcqs_are_conceptual(self):
        blocks = [
            {"block_index": 0, "start": 12.0, "end": 20.0, "text": "The sample size formula is n equals z squared p q over e squared."}
        ]
        importance = [{"block_index": 0, "tier": "high", "score": 0.9}]
        rows = fallback_mcqs(blocks, importance)
        self.assertTrue(rows)
        for q in rows:
            self.assertFalse(is_timestamp_question(q["question"]))
            self.assertEqual(len(q["options"]), 4)


if __name__ == "__main__":
    unittest.main()
