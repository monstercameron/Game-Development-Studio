import sys
from pathlib import Path
import unittest

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from hymotion_backend import generate_motion


class FakeBody:
    j_template = torch.tensor([[0., 1., 0.], [0., 2., 0.]])
    parents = torch.tensor([-1, 0])
    joint_names = ['Pelvis', 'Spine']


class FakePipeline:
    validation_steps = 50
    output_mesh_fps = 30
    body_model = FakeBody()

    def generate(self, prompt, seeds, duration, cfg_scale):
        self.seen = (prompt, seeds, duration, cfg_scale, self.validation_steps)
        identity = torch.eye(3)[:, :2].reshape(6)
        return {'rot6d': identity.repeat(1, 2, 2, 1), 'transl': torch.zeros(1, 2, 3)}


class MotionBackendTests(unittest.TestCase):
    def test_settings_reach_model_and_produce_skeletal_clip(self):
        pipeline = FakePipeline()
        bvh = generate_motion(pipeline, '  person walks  ', duration=2, seed=42, steps=12, guidance=3.5)
        self.assertEqual(pipeline.seen, ('person walks', [42], 2, 3.5, 12))
        self.assertEqual(pipeline.validation_steps, 50)
        self.assertIn('ROOT Pelvis', bvh)
        self.assertIn('JOINT Spine', bvh)
        self.assertIn('Frames: 2', bvh)

    def test_rejects_invalid_settings_and_restores_steps_after_failure(self):
        pipeline = FakePipeline()
        for kwargs in ({'duration': 0}, {'seed': -1}, {'steps': 0}, {'guidance': float('nan')}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                generate_motion(pipeline, 'walk', **kwargs)
        def fail(*args, **kwargs):
            raise RuntimeError('generation failed')
        pipeline.generate = fail
        with self.assertRaisesRegex(RuntimeError, 'generation failed'):
            generate_motion(pipeline, 'walk', steps=12)
        self.assertEqual(pipeline.validation_steps, 50)


if __name__ == '__main__':
    unittest.main()
