// 時計・比較処理の回帰検証専用。アプリにはテスト時刻表を含めない。
const MINUTE=60000;
const rows=[
  ...[[0,8],[9,18],[15,5],[20,5],[25,20],[30,5],[35,8],[50,8]].map(([minute,duration])=>({stationId:'sakurajosui',minute,duration,type:[15,20,30].includes(minute)?'急行':'各駅停車'})),
  ...[3,13,23,33,43,53].map(minute=>({stationId:'shimotakaido',minute,duration:5,type:'各駅停車'}))
];
function getTrains({start,end}){
  const trains=[],hour=new Date(start);hour.setMinutes(0,0,0);
  while(hour.getTime()<=end){
    for(const row of rows){const departure=hour.getTime()+row.minute*MINUTE;if(departure<start||departure>end)continue;
      trains.push({id:row.stationId+':'+departure,stationId:row.stationId,departure,type:row.type,arrival:departure+row.duration*MINUTE});
    }
    hour.setHours(hour.getHours()+1);
  }
  return trains;
}
module.exports={getTrains};
