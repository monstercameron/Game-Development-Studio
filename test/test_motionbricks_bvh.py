import sys
import unittest
from pathlib import Path
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'runtime'))
from motionbricks_bvh import JOINTS, parse_bvh, encode_pose_windows, decode_bvh


def fixture():
    parents=[-1,0,1,2,3,4,5,6,6,6,3,10,11,12,13,13,3,16,17,18,19,19,0,22,23,24,0,26,27,28]
    children=[[] for _ in JOINTS]
    for i,p in enumerate(parents[1:],1):children[p].append(i)
    lines=['HIERARCHY'];order=[]
    def emit(i):
        order.append(i);offset=(-10,-5,0) if i==22 else (10,-5,0) if i==26 else (0,5,0)
        lines.extend([f'{"ROOT" if i==0 else "JOINT"} {JOINTS[i]}','{','OFFSET '+' '.join(map(str,offset)),
                      'CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation' if i==0 else 'CHANNELS 3 Xrotation Yrotation Zrotation'])
        for child in children[i]:emit(child)
        if not children[i]:lines.extend(['End Site','{','OFFSET 0 0 0','}'])
        lines.append('}')
    emit(0);lines.extend(['MOTION','Frames: 12','Frame Time: 0.033333333'])
    for frame in range(12):lines.append(' '.join(map(str,[frame,100,0,0,0,0]+[0]*(3*(len(order)-1)))))
    return '\n'.join(lines)+'\n'


class MotionBricksBvhTests(unittest.TestCase):
    def test_encode_and_decode_pose_windows(self):
        clip=parse_bvh(fixture());inputs,align=encode_pose_windows(clip,0,6,min_tokens=8,max_tokens=10)
        self.assertEqual(inputs['local_poses'].shape,(1,8,267));self.assertEqual(inputs['allowed_pred_num_tokens'].tolist(),[[0,0,1,1,1,0,0,0,0,0,0]])
        raw=np.zeros((1,64,366));raw[0,:,:3]=inputs['global_root_values'][0,3,:3];raw[0,:,92:272]=inputs['local_poses'][0,3,87:]
        result=decode_bvh(clip,{'pred_global_motions':raw,'pred_num_tokens':np.array([8])},align)
        saved=parse_bvh(result);self.assertEqual(len(saved.frames),26);self.assertEqual(saved.stride,1)
        np.testing.assert_allclose(saved.frames[:,0],3.,atol=1e-5);np.testing.assert_allclose(saved.frames[:,1],100.,atol=1e-5)

    def test_rejects_incompatible_and_malformed_input(self):
        text=fixture()
        for invalid in [text.replace('LeftEye','MissingEye'),text.replace('Frame Time: 0.033333333','Frame Time: 0.04'),text.replace('Frames: 12','Frames: 99999'),text.replace('Xrotation Yrotation Zrotation','Xrotation Xrotation Zrotation',1)]:
            with self.subTest(invalid=invalid[:80]),self.assertRaises(ValueError):parse_bvh(invalid)
        clip=parse_bvh(text)
        for args in [(-1,1),(0,10)]:
            with self.assertRaises(ValueError):encode_pose_windows(clip,*args)
        with self.assertRaises(ValueError):encode_pose_windows(clip,0,6,min_tokens=5)
        with self.assertRaises(ValueError):decode_bvh(clip,{'pred_global_motions':np.zeros((1,64,366)),'pred_num_tokens':np.array([8])},{'alignment':np.eye(3),'origin':np.zeros(3)})


if __name__=='__main__':unittest.main()
