"""Run with the Forge SAM Python runtime; the full checkpoint test is opt-in."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
import torch
from PIL import Image
from sam31_backend import _check_compatibility, _restore_derived_buffers, inspect_checkpoint, load_detector, segment_image


class FakeDetector(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = torch.nn.Module()
        self.backbone.vision_backbone = torch.nn.Module()
        self.backbone.vision_backbone.trunk = torch.nn.Module()
        block = torch.nn.Module()
        block.attn = torch.nn.Module()
        block.attn.register_buffer('freqs_cis', torch.tensor([2 + 3j]))
        block.attn.register_buffer('freqs_cis_real', torch.tensor([0.]))
        block.attn.register_buffer('freqs_cis_imag', torch.tensor([0.]))
        block.attn.weight = torch.nn.Parameter(torch.ones(2))
        self.backbone.vision_backbone.trunk.blocks = torch.nn.ModuleList([block])


class Sam31LoaderTests(unittest.TestCase):
    def test_checkpoint_checks_and_rebuilds_only_known_derived_buffers(self):
        model = FakeDetector()
        state = {k: v.clone() for k, v in model.state_dict().items()
                 if not (k.endswith('freqs_cis_real') or k.endswith('freqs_cis_imag'))}
        prefix = 'backbone.vision_backbone.trunk.blocks.0.attn.'
        state[prefix + 'freqs_cis'] = torch.tensor([7 + 11j])
        compatibility = _check_compatibility(model, state)
        self.assertEqual(compatibility['missing'], [])
        self.assertEqual(compatibility['unexpected'], [])
        self.assertEqual(compatibility['incompatible'], [])
        self.assertEqual(len(compatibility['derived_buffers']), 2)
        model.load_state_dict(state, strict=False, assign=True)
        _restore_derived_buffers(model, compatibility['derived_buffers'])
        self.assertEqual(model.backbone.vision_backbone.trunk.blocks[0].attn.freqs_cis_real.item(), 7)
        self.assertEqual(model.backbone.vision_backbone.trunk.blocks[0].attn.freqs_cis_imag.item(), 11)

    def test_missing_unexpected_and_wrong_shape_are_rejected(self):
        model = FakeDetector()
        state = dict(model.state_dict())
        prefix = 'backbone.vision_backbone.trunk.blocks.0.attn.'
        del state[prefix + 'weight']
        state[prefix + 'freqs_cis'] = torch.zeros(2, dtype=torch.complex64)
        state['unknown'] = torch.zeros(1)
        result = _check_compatibility(model, state)
        self.assertEqual(result['missing'], [prefix + 'weight'])
        self.assertEqual(result['incompatible'], [prefix + 'freqs_cis'])
        self.assertEqual(result['unexpected'], ['unknown'])

    def test_loader_assigns_mapped_checkpoint_and_rebuilds_buffers_on_cpu(self):
        source = FakeDetector()
        state = {'detector.' + k: v.clone() for k, v in source.state_dict().items()
                 if not (k.endswith('freqs_cis_real') or k.endswith('freqs_cis_imag'))}
        prefix = 'detector.backbone.vision_backbone.trunk.blocks.0.attn.'
        state[prefix + 'freqs_cis'] = torch.tensor([7 + 11j])
        state[prefix + 'weight'] = torch.tensor([4., 5.])
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / 'model.pt'
            torch.save({'model': state}, checkpoint)
            with patch('sam31_backend._build_detector', FakeDetector):
                processor = load_detector(checkpoint, device='cpu')
        attn = processor.model.backbone.vision_backbone.trunk.blocks[0].attn
        self.assertEqual(attn.weight.tolist(), [4., 5.])
        self.assertEqual(attn.freqs_cis_real.item(), 7)
        self.assertEqual(attn.freqs_cis_imag.item(), 11)
        self.assertFalse(processor.model.training)

    @unittest.skipUnless(os.environ.get('FORGE_TEST_SAM31_CHECKPOINT'), 'checkpoint test not enabled')
    def test_downloaded_checkpoint_matches_detector(self):
        result = inspect_checkpoint(os.environ['FORGE_TEST_SAM31_CHECKPOINT'])
        self.assertEqual(result['missing'], [])
        self.assertEqual(result['unexpected'], [])
        self.assertEqual(result['incompatible'], [])
        self.assertGreater(result['tensors'], 1000)
        self.assertGreater(result['bytes'], 3 * 1024**3)


class FakeProcessor:
    device = 'cpu'

    def __init__(self, masks, scores):
        self.masks = masks
        self.scores = scores

    def set_confidence_threshold(self, value):
        self.confidence = value

    def set_image(self, image):
        self.image = image
        return {'image': True}

    def set_text_prompt(self, prompt, state):
        self.prompt = prompt
        return {**state, 'masks': self.masks, 'scores': self.scores}


class Sam31OutputTests(unittest.TestCase):
    def test_union_mask_preserves_existing_alpha_and_produces_mask_export(self):
        source = Image.new('RGBA', (2, 2))
        source.putdata([(20, 30, 40, 80), (10, 20, 30, 255), (90, 80, 70, 120), (1, 2, 3, 255)])
        masks = torch.tensor([[[[1, 0], [0, 0]]], [[[0, 0], [1, 0]]]], dtype=torch.bool)
        processor = FakeProcessor(masks, torch.tensor([0.8, 0.7]))
        cutout, metadata = segment_image(processor, source, '  tree  ', confidence=0.4)
        self.assertEqual(list(cutout.getchannel('A').getdata()), [80, 0, 120, 0])
        self.assertEqual(metadata, {'instances': 2, 'selectedPixels': 2})
        self.assertEqual(processor.prompt, 'tree')
        self.assertEqual(processor.confidence, 0.4)
        self.assertEqual(processor.image.mode, 'RGB')
        mask, _ = segment_image(processor, source, 'tree', output='mask')
        self.assertEqual(mask.mode, 'L')
        self.assertEqual(list(mask.getdata()), [255, 0, 255, 0])

    def test_empty_or_malformed_model_results_fail_without_creating_a_blank_asset(self):
        source = Image.new('RGB', (2, 2))
        with self.assertRaisesRegex(ValueError, 'No matching objects'):
            segment_image(FakeProcessor(torch.zeros((0, 1, 2, 2), dtype=torch.bool), torch.zeros(0)), source, 'tree')
        with self.assertRaisesRegex(ValueError, 'empty masks'):
            segment_image(FakeProcessor(torch.zeros((1, 1, 2, 2), dtype=torch.bool), torch.ones(1)), source, 'tree')
        with self.assertRaisesRegex(RuntimeError, 'invalid masks'):
            segment_image(FakeProcessor(torch.ones((1, 2, 2), dtype=torch.bool), torch.ones(1)), source, 'tree')
        with self.assertRaisesRegex(RuntimeError, 'invalid confidence scores'):
            segment_image(FakeProcessor(torch.ones((1, 1, 2, 2), dtype=torch.bool), torch.ones(2)), source, 'tree')

    def test_rejects_invalid_prompts_output_and_confidence(self):
        processor = FakeProcessor(torch.ones((1, 1, 2, 2), dtype=torch.bool), torch.ones(1))
        source = Image.new('RGB', (2, 2))
        for prompt, output, confidence in [('', 'mask', 0.5), ('tree', 'jpg', 0.5), ('tree', 'mask', float('nan')), ('tree', 'mask', True)]:
            with self.subTest(prompt=prompt, output=output, confidence=confidence):
                with self.assertRaises(ValueError):
                    segment_image(processor, source, prompt, output=output, confidence=confidence)


if __name__ == '__main__':
    unittest.main()
