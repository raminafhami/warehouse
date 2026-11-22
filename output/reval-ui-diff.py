from pathlib import Path
import json
import numpy as np
from PIL import Image
root=Path('output/reval-ui-parity')
metrics=[]
for folder in ('1440x900','1920x1080','1024x768'):
    path=root/folder
    for reference in sorted(path.glob('ref-*.png')):
        current=path/('app-'+reference.name[4:])
        a=np.array(Image.open(reference).convert('RGB'),dtype=np.int16)
        b=np.array(Image.open(current).convert('RGB'),dtype=np.int16)
        difference=np.abs(a-b).max(axis=2)
        metrics.append({'viewport':folder,'view':reference.stem[4:],
                        'exact':bool(np.all(difference==0)),
                        'changed_pixel_percent':round(float(np.mean(difference>0)*100),2),
                        'above_16_channel_delta_percent':round(float(np.mean(difference>16)*100),2)})
(root/'pixel-diff.json').write_text(json.dumps(metrics,indent=2),encoding='utf8')
for name in ('login','dashboard'):
    print(name,[(r['viewport'],r['above_16_channel_delta_percent']) for r in metrics if r['view']==name])
print('pairs',len(metrics),'exact',sum(row['exact'] for row in metrics))