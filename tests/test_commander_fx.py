"""Commander animation settings, checked without starting Flask or table hardware."""
import ast
from pathlib import Path
import re
import unittest


class CommanderFxTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path('web.py').read_text(encoding='utf-8'))
        functions = {'default_commander_fx', 'apply_commander_fx', 'clean_focus'}
        constants = {'COMMANDER_FX_EFFECTS', 'COMMANDER_FX_LABELS', 'COMMANDER_FX_AREAS'}
        nodes = [node for node in source.body if
                 isinstance(node, ast.FunctionDef) and node.name in functions or
                 isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in node.targets)]
        self.scope = {'re': re}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'web.py', 'exec'), self.scope)
        self.fx = self.scope['default_commander_fx']()
        self.apply = self.scope['apply_commander_fx']

    def test_default_is_foil_on_the_art(self):
        self.assertEqual(self.fx, {'effect': 'foil', 'focus': '', 'glow': '', 'area': 'art'})

    def test_change_is_merged_and_points_normalised(self):
        self.apply(self.fx, {'effect': 'dragon', 'focus': '48.0% 40%', 'glow': '52.5% 22%', 'area': 'card', 'slot': 2},
                   strict=True)
        self.assertEqual(self.fx, {'effect': 'dragon', 'focus': '48% 40%', 'glow': '52.5% 22%', 'area': 'card'})

    def test_bad_change_from_the_page_is_refused(self):
        for bad in ({'effect': 'bogus'}, {'focus': '120% 3%'}, {'glow': 'eyes'}, {'area': 'side'}, 'not a dict'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.apply(dict(self.fx), bad, strict=True)

    def test_bad_saved_fields_are_skipped_when_loading(self):
        self.apply(self.fx, {'effect': 'bogus', 'focus': 'nope', 'area': 'arcane', 'glow': '30% 28%'})
        self.assertEqual(self.fx, {'effect': 'foil', 'focus': '', 'glow': '30% 28%', 'area': 'art'})

    def test_effect_ids_match_the_renderer(self):
        renderer = Path('js/commander-fx.js').read_text(encoding='utf-8')
        listed = re.search(r"var EFFECTS = \[([^\]]*)\]", renderer).group(1)
        shader_ids = re.findall(r"'([a-z]+)'", listed)
        server_ids = [effect for effect, _ in self.scope['COMMANDER_FX_EFFECTS'] if effect != 'none']
        self.assertEqual(sorted(shader_ids), sorted(server_ids))


if __name__ == '__main__':
    unittest.main()
