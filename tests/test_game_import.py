"""Importing the phone tracker's games, checked without starting Flask or table hardware."""
import ast
import re
from datetime import datetime
from pathlib import Path
import unittest
from uuid import uuid4


FUNCTIONS = {'import_submissions', 'imported_created_at', 'game_signature', 'plan_game_import',
             'game_from_payload', 'clean_game_text', 'clean_game_stats'}
CONSTANTS = {'IMPORTABLE_STATUSES', 'GAME_STAT_FIELDS', 'GAME_STAT_MAX', 'GAME_ID_PATTERN',
             'GAME_PLAYER_COUNT', 'GAME_NAME_MAX', 'GAME_DECK_MAX', 'ROSTER_COMMANDER_MAX'}


def game(game_id, date='2026-11-09', ranks=(1, 2, 3, 4), decks=('Niv-Mizzet', 'Zndrsplt', 'Jace', 'Raffine'), **extra):
    names = ('Ny', 'Coach', 'Borgo', 'Milli')
    return {'id': game_id, 'date': date, 'outcome': 'win', **extra,
            'players': [{'name': n, 'deck': d, 'rank': r} for n, d, r in zip(names, decks, ranks)]}


def submission(game_id, replaces=None, new_decks=None, **extra):
    source = {'app': 'phone-tracker'}
    if replaces:
        source['replaces'] = replaces
    return {'id': game_id, 'received_at': '2026-11-09T10:00:00.000Z', 'source': source,
            'game': game(game_id, **extra), 'table': {}, 'timeline': [], 'new_decks': new_decks or []}


A, B, C, D = ('a' * 32), ('b' * 32), ('c' * 32), ('d' * 32)


class GameImportTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path('web.py').read_text(encoding='utf-8'))
        nodes = [node for node in source.body if
                 isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS or
                 isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in CONSTANTS for t in node.targets)]
        self.scope = {'re': re, 'datetime': datetime, 'uuid4': uuid4}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'web.py', 'exec'), self.scope)

    def plan(self, submissions, history=(), known=lambda name: False):
        return self.scope['plan_game_import'](submissions, list(history), known)

    def statuses(self, plan):
        return [entry['status'] for entry in plan['entries']]

    def test_reads_inbox_download_list_and_bare_game(self):
        read = self.scope['import_submissions']
        inbox = {'format': 'mtg-table-inbox', 'version': 1, 'submissions': [submission(A), submission(B)]}
        download = {'format': 'mtg-table-game', 'version': 1, **submission(C)}
        self.assertEqual(len(read(inbox)), 2)
        self.assertEqual(len(read(download)), 1)
        self.assertEqual(len(read([inbox, download, game(D)])), 4)
        for junk in ({}, 'text', 3, {'games': 'x'}):
            with self.assertRaises(ValueError):
                read(junk)

    def test_new_game_keeps_its_id_and_time(self):
        entry = self.plan([submission(A, created_at='2026-11-08T23:40:55+01:00')])['entries'][0]
        self.assertEqual(entry['status'], 'new')
        self.assertEqual(entry['game']['id'], A)
        self.assertEqual(datetime.fromisoformat(entry['game']['created_at']),
                         datetime.fromisoformat('2026-11-08T23:40:55+01:00'))

    def test_already_imported_is_filtered(self):
        history = [dict(game(A), created_at='2026-11-09T11:00:00+01:00')]
        self.assertEqual(self.statuses(self.plan([submission(A), submission(B, ranks=(2, 1, 3, 4))], history)),
                         ['imported', 'new'])

    def test_correction_in_the_same_file_drops_the_original(self):
        plan = self.plan([submission(A), submission(B, replaces=A, ranks=(2, 1, 3, 4))])
        self.assertEqual(self.statuses(plan), ['superseded', 'new'])

    def test_correction_replaces_a_saved_game(self):
        plan = self.plan([submission(B, replaces=A, ranks=(2, 1, 3, 4))], [game(A)])
        self.assertEqual(self.statuses(plan), ['correction'])
        self.assertEqual(plan['entries'][0]['replaces'], A)

    def test_original_stays_out_after_its_correction_was_imported(self):
        plan = self.plan([submission(A), submission(B, replaces=A, ranks=(2, 1, 3, 4))],
                         [game(B, ranks=(2, 1, 3, 4))])
        self.assertEqual(self.statuses(plan), ['superseded', 'imported'])

    def test_same_result_typed_by_hand_is_flagged(self):
        plan = self.plan([submission(A)], [game(C)])
        self.assertEqual(self.statuses(plan), ['match'])
        self.assertEqual(plan['entries'][0]['match_id'], C)
        # A different deck is a different result.
        plan = self.plan([submission(A, decks=('Urza', 'Zndrsplt', 'Jace', 'Raffine'))], [game(C)])
        self.assertEqual(self.statuses(plan), ['new'])

    def test_invalid_and_repeated_entries(self):
        bad = submission(B)
        bad['game']['players'] = bad['game']['players'][:3]
        no_id = submission(C)
        no_id['game']['id'] = 'not-an-id'
        plan = self.plan([submission(A), bad, no_id, submission(A)])
        self.assertEqual(self.statuses(plan), ['new', 'invalid', 'invalid', 'repeat'])
        self.assertIn('four players', plan['entries'][1]['message'])

    def test_new_decks_only_for_imported_games_and_unknown_decks(self):
        ghave = {'name': 'Ghave', 'commander': 'Ghave, Guru of Spores', 'color_identity': ['W', 'B', 'G']}
        urza = {'name': 'Urza', 'commander': 'Urza, Lord High Artificer', 'color_identity': ['U']}
        decks = ('Ghave', 'Urza', 'Jace', 'Raffine')
        plan = self.plan([submission(A, new_decks=[ghave, urza], decks=decks),
                          submission(B, new_decks=[{'name': 'Skipped'}], ranks=(2, 1, 3, 4))],
                         [game(B, ranks=(2, 1, 3, 4))], known=lambda name: name == 'Urza')
        self.assertEqual([(deck['name'], deck['colors'], deck['game']) for deck in plan['new_decks']],
                         [('Ghave', 'WBG', A)])


if __name__ == '__main__':
    unittest.main()
