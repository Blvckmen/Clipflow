import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from captions import chunk, clean

def words(text, start=0.0, step=0.3):
    return [(start + i * step, start + i * step + 0.25, " " + w) for i, w in enumerate(text.split())]

class ChunkTest(unittest.TestCase):
    def test_caps_words_per_cue(self):
        cues = chunk([words("one two three four five six")])
        self.assertEqual([c[2] for c in cues], ["one two three four", "five six"])

    def test_caps_characters(self):
        cues = chunk([words("incredible unbelievable outrageous")])
        self.assertTrue(all(len(c[2]) <= 24 for c in cues))

    def test_breaks_after_sentence_end_and_on_pause(self):
        self.assertEqual([c[2] for c in chunk([words("let's go. again now")])], ["let's go.", "again now"])
        pause = words("before") + words("after", start=5.0)
        self.assertEqual([c[2] for c in chunk([pause])], ["before", "after"])

    def test_never_merges_segments_and_cues_do_not_overlap(self):
        cues = chunk([words("a b"), words("c d", start=0.7)])
        self.assertEqual([c[2] for c in cues], ["a b", "c d"])
        self.assertTrue(all(cues[i][1] <= cues[i + 1][0] for i in range(len(cues) - 1)))

    def test_strips_libass_override_syntax(self):
        self.assertEqual(clean(" {\\an8}hi<b>"), "an8hib")
        self.assertEqual(chunk([[(0, 0.2, " {}"), (0.3, 0.5, " ok")]])[0][2], "ok")

if __name__ == "__main__":
    unittest.main()
