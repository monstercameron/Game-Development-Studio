import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
import motionbricks_backend as backend


def values(rig):
    result = {name: np.zeros(shape, np.float32) for name, shape in backend.FLOATS[rig].items()}
    result.update({name: np.ones(shape, np.int32) for name, shape in backend.MASKS.items()})
    if rig == 'g1':
        result['context_qpos'][..., 6] = 1
        result['target_qpos'][..., 6] = 1
    return result


class BackendTests(unittest.TestCase):
    def test_loading_does_not_fall_back_to_cpu(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / backend.MODELS['soma']).touch()
            fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
            with patch.dict(sys.modules, {'torch':fake}), self.assertRaisesRegex(RuntimeError, 'CPU fallback is disabled'):
                backend.load_model(directory, 'soma')

    def test_inputs_reject_missing_malformed_nonfinite_and_disabled_lengths(self):
        data = values('soma')
        self.assertEqual(backend.prepare_inputs('soma', data)['local_poses'].dtype, np.float32)
        for name, bad in [('local_poses', [[[0]]]), ('allowed_pred_num_tokens', np.zeros((1, 11))),
                          ('has_local_poses', np.full((1, 8), 0.5)),
                          ('local_root_values', np.full((1, 8, 4), float('nan')))]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                backend.prepare_inputs('soma', {**data, name: bad})
        with self.assertRaises(ValueError): backend.prepare_inputs('g1', values('soma'))
        with self.assertRaises(ValueError): backend.prepare_inputs('g1', {**values('g1'), 'target_qpos': np.zeros((1,4,36))})

    def test_checks_output_by_name_and_rejects_unallowed_token_count(self):
        class Field:
            def __init__(self, name): self.name = name
        class Fake:
            def get_outputs(self): return [Field('pred_num_tokens'), Field('pred_global_motions')]
            def run(self, names, inputs): return [np.array([6]), np.zeros((1,64,366), np.float32)]
        self.assertEqual(backend.infer(Fake(), 'soma', values('soma'))['pred_num_tokens'][0], 6)
        data = values('soma'); data['allowed_pred_num_tokens'][0,0] = 0
        with self.assertRaises(RuntimeError): backend.infer(Fake(), 'soma', data)


if __name__ == '__main__': unittest.main()
