"""Intro settings and export checks without starting Flask or table hardware."""
import ast
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_site


class IntroConfigTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path('web.py').read_text(encoding='utf-8'))
        constants = {'INTRO_SOUNDS', 'INTRO_REPEATS', 'INTRO_NUMBERS', 'INTRO_WHOLE_NUMBERS'}
        nodes = [node for node in source.body if
                 isinstance(node, ast.FunctionDef) and node.name == 'clean_intro' or
                 isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in node.targets)]
        self.scope = {'list_intro_sounds': lambda: [{'file': 'Chain rattle.mp3'}]}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'web.py', 'exec'), self.scope)

    def test_legacy_settings_get_chain_default_and_stronger_rattles(self):
        saved = self.scope['clean_intro']({})
        self.assertEqual(saved['chain'], '')
        self.assertEqual(saved['rattle'], 90)
        self.assertEqual(saved['rattle_every'], 0.7)
        self.assertEqual(saved['rotation_speed'], 2)

    def test_rotation_speed_is_saved_and_validated(self):
        clean = self.scope['clean_intro']
        self.assertEqual(clean({'rotation_speed': 3.5})['rotation_speed'], 3.5)
        with self.assertRaises(ValueError):
            clean({'rotation_speed': 9})

    def test_chain_file_is_validated_and_round_trips(self):
        clean = self.scope['clean_intro']
        self.assertEqual(clean({'chain': 'Chain rattle.mp3'})['chain'], 'Chain rattle.mp3')
        with self.assertRaises(ValueError):
            clean({'chain': '../outside.mp3'})
        self.assertEqual(clean({'chain': 'deleted.mp3'}, strict=False)['chain'], '')

    def test_build_copies_chain_sound_and_rewrites_url(self):
        with tempfile.TemporaryDirectory(prefix='mtg-intro-test-') as folder:
            root = Path(folder).resolve()
            site, sounds, out = (root / name for name in ('site', 'Intro', 'out'))
            for directory in (site, sounds, out / 'sound'):
                directory.mkdir(parents=True)
            (site / 'intro.json').write_text(json.dumps({'chain': 'Chain rattle.mp3', 'thud': ''}), encoding='utf-8')
            (sounds / 'Chain rattle.mp3').write_bytes(b'test audio asset')
            with patch.multiple(build_site, SITE_DIR=site, INTRO_SOUND_DIR=sounds, OUT_DIR=out, published_sounds={}):
                build_site.publish_intro()
            saved = json.loads((out / 'intro.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['chain'], 'sound/intro-chain-rattle.mp3')
            self.assertEqual((out / saved['chain']).read_bytes(), b'test audio asset')


if __name__ == '__main__':
    unittest.main()
