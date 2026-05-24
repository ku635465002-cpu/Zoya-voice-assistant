import React, { useState, useEffect } from 'react';
import { collectionGroup, query, orderBy, onSnapshot, limit, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { Trash2 } from 'lucide-react';

interface GlobalAction {
  id: string;
  name: string;
  argSummary: string;
  timestamp: number;
  docPath: string;
}

export default function AdminPanel() {
  const [actions, setActions] = useState<GlobalAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(
      collectionGroup(db, 'actions'),
      orderBy('timestamp', 'desc'),
      limit(50)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const gActions = snapshot.docs.map(d => ({
        ...d.data() as any,
        docPath: d.ref.path
      }));
      setActions(gActions);
      setLoading(false);
    }, (err) => {
      console.error("Admin read error", err);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleDelete = async (docPath: string) => {
    if (confirm('Are you sure you want to delete this action?')) {
      try {
        await deleteDoc(doc(db, docPath));
      } catch (err) {
        console.error("Failed to delete", err);
        alert("Failed to delete. Check console.");
      }
    }
  };

  if (loading) return <div className="text-neutral-500 text-sm mt-4">Loading Admin Data...</div>;

  return (
    <div className="w-full max-w-2xl mt-12 bg-neutral-900 border border-neutral-800 rounded-3xl p-6 relative">
      <div className="absolute -top-3 left-6 px-3 bg-neutral-950 font-bold text-pink-500 text-sm uppercase tracking-widest border border-neutral-800 rounded-full">
        Owner Control Panel
      </div>
      
      <div className="space-y-3 mt-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
        {actions.length === 0 ? (
          <p className="text-neutral-500 text-sm text-center py-4">No global actions found.</p>
        ) : (
          actions.map((act) => (
            <div key={act.id + act.docPath} className="flex flex-col p-3 bg-neutral-950 rounded-xl border border-neutral-800/50 hover:border-neutral-700 transition-colors">
              <div className="flex items-center justify-between">
                <div className="font-mono text-xs text-pink-400">
                  {act.name}
                </div>
                <div className="flex items-center space-x-3">
                  <span className="text-[10px] text-neutral-600">
                    {new Date(act.timestamp).toLocaleString()}
                  </span>
                  <button 
                    onClick={() => handleDelete(act.docPath)}
                    className="p-1.5 text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-lg transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="text-sm text-neutral-300 mt-1.5 break-words">
                {act.argSummary}
              </div>
              <div className="text-[9px] text-neutral-600 mt-2 truncate max-w-[80%] opacity-50" title={act.docPath}>
                {act.docPath}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
